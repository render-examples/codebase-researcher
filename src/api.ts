import { MESSAGE_MAX_CHARS, Transcript, TRANSCRIPT_MAX_MESSAGES } from "./investigation.ts";
import { QuestionMetadata, replyText, type Reply, type StartQuestion } from "./question.ts";
import { present } from "./util.ts";
import { safeEqual } from "./callback.ts";
import { assertCallbackAllowed, loadCallbackPolicy, type CallbackPolicy } from "./callback-policy.ts";
import { createLog, type Log } from "./log.ts";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { ClientError, Render } from "@renderinc/sdk";
import { z } from "zod";
import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type TaskRun = { status: string; input?: unknown; results: unknown[]; error?: string };
export type GetTaskRun = (id: string) => Promise<TaskRun>;

export type AppDeps = {
  apiToken: string;
  startQuestion: StartQuestion;
  getTaskRun: GetTaskRun;
  isLocalDev: boolean;
  callbackAllowedOrigins?: readonly string[];
  log: Log;
};

/**
 * A question id is `<task run id>.<HMAC>`, so `GET` only reads runs this API started; the API token alone
 * can't be used to read other runs in the workspace. Rotating API_TOKEN invalidates outstanding ids.
 */
const questionIdMac = (apiToken: string, runId: string) =>
  createHmac("sha256", apiToken).update(`question-id:${runId}`).digest("base64url").slice(0, 22);

export const toQuestionId = (apiToken: string, runId: string) => `${runId}.${questionIdMac(apiToken, runId)}`;

export function fromQuestionId(apiToken: string, questionId: string): string | null {
  const dot = questionId.lastIndexOf(".");
  if (dot <= 0) return null;
  const runId = questionId.slice(0, dot);
  return safeEqual(questionId.slice(dot + 1), questionIdMac(apiToken, runId)) ? runId : null;
}

const postBody = (policy: CallbackPolicy) =>
  z.object({
    question: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
    follow_up_to: z.string().min(1).optional(),
    callback: z.object({
      url: z.url().refine((raw) => {
        try {
          assertCallbackAllowed(raw, policy);
          return true;
        } catch {
          return false;
        }
      }, "callback URL must use an origin approved by CALLBACK_ALLOWED_ORIGINS (HTTPS, or explicit loopback HTTP in local dev; no credentials)"),
      secret: z.string().min(16).max(256),
    }).optional(),
    metadata: QuestionMetadata.optional(),
  });

const httpError = (status: 400 | 404 | 409, error: string) =>
  new HTTPException(status, { res: Response.json({ error }, { status }) });

function completedReply(run: TaskRun): { trace_id?: string; reply?: Reply } | undefined {
  if (run.status !== "succeeded" && run.status !== "completed") return undefined;
  return (run.results?.[0] ?? {}) as { trace_id?: string; reply?: Reply };
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const PostBody = postBody({ allowedOrigins: deps.callbackAllowedOrigins ?? [], isLocalDev: deps.isLocalDev });

  async function readRun(questionId: string): Promise<TaskRun> {
    const runId = fromQuestionId(deps.apiToken, questionId);
    if (!runId) throw httpError(404, "not found");
    try {
      return await deps.getTaskRun(runId);
    } catch (err) {
      if (err instanceof ClientError && err.statusCode === 404) throw httpError(404, "not found");
      throw err;
    }
  }

  /** The earlier question's conversation plus its reply, so a follow-up carries the whole exchange. */
  async function conversationSoFar(questionId: string): Promise<Transcript> {
    const run = await readRun(questionId);
    const reply = completedReply(run)?.reply;
    if (!reply) throw httpError(409, "follow_up_to has no reply yet: it is still running, or its run failed");
    const input = Array.isArray(run.input) ? run.input[0] : undefined;
    const earlier = Transcript.safeParse((input as { transcript?: unknown } | undefined)?.transcript);
    if (!earlier.success) throw httpError(400, "follow_up_to is not a question this API can continue");
    return [...earlier.data, { role: "agent", text: replyText(reply) }];
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    deps.log.error("request failed", {
      event: "request_failed",
      method: c.req.method,
      path: c.req.path,
      error: err.message,
    });
    return c.text("internal error", 500);
  });

  app.get("/healthz", (c) => c.text("ok"));

  app.use("/v1/*", bearerAuth({ token: deps.apiToken }));

  app.post(
    "/v1/questions",
    validator("json", (value, c) => {
      const parsed = PostBody.safeParse(value);
      return parsed.success ? parsed.data : c.json({ error: z.prettifyError(parsed.error) }, 400);
    }),
    async (c) => {
      const { question, follow_up_to, callback, metadata } = c.req.valid("json");
      const earlier = follow_up_to ? await conversationSoFar(follow_up_to) : [];
      const transcript: Transcript = [...earlier, { role: "user", text: question }];
      if (transcript.length > TRANSCRIPT_MAX_MESSAGES) {
        throw httpError(400, `a conversation holds at most ${TRANSCRIPT_MAX_MESSAGES} messages; ask a new question instead`);
      }
      const run = await deps.startQuestion({ transcript, callback, metadata }, {
        idempotencyKey: c.req.header("idempotency-key"),
        signal: AbortSignal.timeout(5000),
      });
      deps.log.info("task started", { event: "task_started", run_id: run.id, follow_up: !!follow_up_to });
      return c.json({ id: toQuestionId(deps.apiToken, run.id) }, 202);
    },
  );

  app.get("/v1/questions/:id", async (c) => {
    const id = c.req.param("id");
    const run = await readRun(id);
    const status = run.status;
    if (status === "pending" || status === "running" || status === "paused") {
      return c.json({ id, status: "running" });
    }
    const result = completedReply(run);
    if (result) {
      return c.json({ id, status: "completed", trace_id: result.trace_id, reply: result.reply });
    }
    // failed or canceled
    return c.json({ id, status: "failed", error: run.error ?? "task failed" });
  });

  return app;
}

const Env = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    API_TOKEN: z.string().min(1, "API_TOKEN is required"),
    RENDER_API_KEY: z.string().min(1).optional(),
    RENDER_LOCAL_DEV_URL: z.string().min(1).optional(),
    WORKFLOW_SLUG: z.string().min(1).default("codebase-researcher-workflow"),
  })
  .refine((e) => e.RENDER_LOCAL_DEV_URL || e.RENDER_API_KEY, {
    message: "RENDER_API_KEY is required unless RENDER_LOCAL_DEV_URL is set",
  })
  .transform((e) => ({
    port: e.PORT,
    apiToken: e.API_TOKEN,
    renderApiKey: e.RENDER_API_KEY,
    localDevUrl: e.RENDER_LOCAL_DEV_URL,
    taskSlug: `${e.WORKFLOW_SLUG}/answer_question`,
  }));

export type ApiConfig = z.output<typeof Env> & { callbackPolicy: CallbackPolicy };

export function loadEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return { ...Env.parse(present(env)), callbackPolicy: loadCallbackPolicy(env) };
}

// Starts the server only when run directly, not when tests import this module.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const env = loadEnv();

  const render = new Render(
    env.localDevUrl ? { useLocalDev: true, localDevUrl: env.localDevUrl } : { token: env.renderApiKey },
  );

  const startQuestion: StartQuestion = async (input, opts) => {
    const run = await render.workflows.startTask(
      env.taskSlug,
      [input],
      { idempotencyKey: opts.idempotencyKey, signal: opts.signal },
    );
    return { id: run.taskRunId };
  };

  const getTaskRun: GetTaskRun = (id) => render.workflows.getTaskRun(id);

  const log = createLog();

  const app = createApp({
    apiToken: env.apiToken,
    startQuestion,
    getTaskRun,
    isLocalDev: env.callbackPolicy.isLocalDev,
    callbackAllowedOrigins: env.callbackPolicy.allowedOrigins,
    log,
  });

  const server = serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
    log.info("listening", { event: "listening", port: info.port });
  });

  const shutdown = () => {
    log.info("shutting down", { event: "shutting_down" });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGTERM", shutdown);
}
