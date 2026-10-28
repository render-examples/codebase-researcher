import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { callbackOrigins, isApprovedCallback, verifyCallback } from "../src/callback.ts";
import type { Evidence, InvestigationResult } from "../src/investigation.ts";
import { createLog } from "../src/log.ts";
import type { AnswerQuestionInput } from "../src/question.ts";
import type { RunnerEvent } from "../src/runner/protocol.ts";
import type { OpenSandbox } from "../src/sandbox/interface.ts";
import { answerQuestion, deliverCallback, investigateTask, type DeliverInput, type InvestigateInput } from "../src/tasks.ts";
import {
  DELIVER_MAX_RETRIES,
  DELIVER_TIMEOUT_S,
  INVESTIGATE_MAX_RETRIES,
  investigateTimeoutSeconds,
  loadConfig,
  parentTimeoutSeconds,
} from "../src/workflow.ts";
import { FakeSandboxes, TEST_MANIFEST, type Script } from "./fakes.ts";

const at = () => new Date().toISOString();
const MODEL_KEY = "sk-ant-api03-tasksTestSecret";

const events = {
  started: (): RunnerEvent => ({ type: "started", at: at(), pi_version: "0.83.0", model: "claude-sonnet-4-5", prompt_version: "v1" }),
  result: (result: InvestigationResult): RunnerEvent => ({ type: "result", at: at(), result }),
  error: (message = "runner said agent_error"): RunnerEvent => ({ type: "error", at: at(), code: "agent_error", message }),
};

const evidence: Evidence = {
  repository: "render-oss/cli",
  commit: "c".repeat(40),
  path: "cmd/deploy.go",
  start_line: 10,
  end_line: 24,
};

const answer: InvestigationResult = {
  status: "final_answer",
  answer: "Yes, up to three times.",
  confidence: "medium",
  observed_in_code: ["deploy retries on 5xx"],
  inferred_behavior: [],
  not_established: ["server-side retry policy"],
  evidence: [evidence],
  suggested_owner: "cli",
  escalation_question: "Does the API retry too?",
};

const clarification: InvestigationResult = {
  status: "needs_clarification",
  question: "Which CLI version?",
  why_needed: "Retry logic changed in v2.",
};

const success = (result: InvestigationResult = answer): Script => ({ events: [events.started(), events.result(result)] });

const QUESTION: AnswerQuestionInput = { transcript: [{ role: "user", text: "Does render deploy retry?" }] };
const CALLBACK = { url: "https://example.com/hook", secret: "a".repeat(32) };

function harness(env: Record<string, string> = {}) {
  const sandboxes = new FakeSandboxes();
  const logs: Record<string, unknown>[] = [];
  const config = loadConfig({ CALLBACK_ALLOWED_ORIGINS: "https://example.com", ...env });
  const log = createLog({}, (line: string) => void logs.push(JSON.parse(line)));
  const deliveries: DeliverInput[] = [];
  const h = {
    sandboxes,
    logs,
    deliveries,
    config,
    configureSandboxes: async (_allowedDomain: string): Promise<OpenSandbox> => sandboxes.open,
    investigate: (input: InvestigateInput) =>
      investigateTask({ config, log, configureSandboxes: (domain) => h.configureSandboxes(domain) }, input),
    deliver: async (input: DeliverInput) => void deliveries.push(input),
    ask: (input: unknown, traceId = "trace-1") =>
      answerQuestion({ config, log, runInvestigate: (i) => h.investigate(i), runDeliver: (d) => h.deliver(d) }, traceId, input),
  };
  return h;
}
type Harness = ReturnType<typeof harness>;

describe("answerQuestion", () => {
  it("returns an answer, delivers it to the callback with the caller's metadata, and closes the sandbox", async () => {
    const h = harness();
    h.sandboxes.script(success());
    const metadata = { ticket: "T-1" };

    const result = await h.ask({ ...QUESTION, callback: CALLBACK, metadata }, "trace-1");

    expect(result).toMatchObject({
      trace_id: "trace-1",
      outcome: "answer",
      reply: {
        kind: "answer",
        traceId: "trace-1",
        model: "claude-sonnet-4-5",
        manifestCreatedAt: TEST_MANIFEST.created_at,
        result: { status: "final_answer", answer: answer.answer },
      },
    });
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]!.callback).toEqual(CALLBACK);
    expect(JSON.parse(h.deliveries[0]!.body)).toEqual({ trace_id: "trace-1", reply: result.reply, metadata });
    expect(h.sandboxes.closed).toEqual(["sbx-1"]);
  });

  it("skips delivery to an unapproved callback origin but still returns the reply for polling", async () => {
    const h = harness({ CALLBACK_ALLOWED_ORIGINS: "https://receiver.example" });
    h.sandboxes.script(success());

    const result = await h.ask({ ...QUESTION, callback: CALLBACK });

    expect(result.outcome).toBe("answer");
    expect(h.deliveries).toEqual([]);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "deliver_skipped", origin: "https://example.com" }));
  });

  it("returns a clarification when the agent needs one", async () => {
    const h = harness();
    h.sandboxes.script(success(clarification));
    const result = await h.ask(QUESTION, "trace-2");
    expect(result).toMatchObject({ outcome: "clarification", reply: { kind: "clarification", traceId: "trace-2", result: clarification } });
  });

  it.each<{ name: string; env?: Record<string, string>; arrange: (h: Harness) => void; reason: string }>([
    {
      name: "the agent stops without an answer",
      arrange: (h) => h.sandboxes.script({ events: [events.started(), events.error()] }),
      reason: "the agent stopped without submitting an answer",
    },
    {
      name: "the runner hits the agent timeout",
      arrange: (h) => h.sandboxes.script({ events: [events.started()], exitCode: 124 }),
      reason: "the investigation hit the 15-minute limit",
    },
    {
      name: "no snapshot exists",
      arrange: (h) => void (h.sandboxes.noSnapshot = true),
      reason: "no repository snapshot is available",
    },
    {
      name: "the snapshot isn't ready",
      arrange: (h) => void (h.sandboxes.noSnapshot = "notReady"),
      reason: "the repository snapshot isn't ready",
    },
    {
      name: "the model is unknown",
      env: { MODEL_PROVIDER: "fake-provider", MODEL: "fake-model" },
      arrange: () => {},
      reason: "misconfigured",
    },
    {
      name: "the sandbox config is invalid",
      arrange: (h) => {
        h.configureSandboxes = async () => {
          throw new Error("RENDER_API_KEY is required");
        };
      },
      reason: "misconfigured",
    },
  ])("replies with a user-safe failure when $name", async ({ env, arrange, reason }) => {
    const h = harness(env);
    arrange(h);
    const { outcome, reply } = await h.ask(QUESTION);
    expect(outcome).toBe("failure");
    expect(reply).toMatchObject({ kind: "failure", reason: expect.stringContaining(reason) });
    expect(JSON.stringify(reply)).not.toMatch(/runner said|RENDER_API_KEY/);
  });

  it("throws on infrastructure failures so the workflow retries, and replies with a failure once retries run out", async () => {
    const h = harness();
    h.sandboxes.script({ events: [events.started()], streamLost: true });
    const attempt = h.investigate;
    let thrown: unknown;
    h.investigate = (input) => attempt(input).catch((err: unknown) => { thrown = err; throw err; });

    const { reply } = await h.ask(QUESTION);

    expect(thrown).toBeInstanceOf(Error);
    expect(reply).toMatchObject({ kind: "failure", reason: expect.stringContaining("kept failing on infrastructure errors") });
    expect(h.sandboxes.closed).toEqual(["sbx-1"]);
  });

  it("delivers a failure reply to the callback when the question is invalid", async () => {
    const h = harness();
    const { reply } = await h.ask({ transcript: [{ role: "user", text: "x".repeat(8001) }], callback: CALLBACK, metadata: { ticket: "T-1" } });

    expect(reply).toMatchObject({ kind: "failure", reason: expect.stringContaining("couldn't be read") });
    expect(h.sandboxes.runs).toHaveLength(0);
    expect(h.deliveries).toHaveLength(1);
    expect(JSON.parse(h.deliveries[0]!.body)).toMatchObject({ reply: { kind: "failure" }, metadata: { ticket: "T-1" } });
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "invalid_question" }));
  });

  it("still returns the reply when delivery fails", async () => {
    const h = harness();
    h.sandboxes.script(success());
    h.deliver = async () => {
      throw new Error("deliver exploded");
    };
    const result = await h.ask({ ...QUESTION, callback: CALLBACK });
    expect(result.outcome).toBe("answer");
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "error", event: "deliver_failed" }));
  });

  it("logs one turn_finished line with the documented fields", async () => {
    const h = harness();
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 5, cache_write_tokens: 0, cost_usd: 0.01 };
    h.sandboxes.script({ events: [events.started(), { type: "usage", at: at(), usage }, events.result(answer)] });

    await h.ask(QUESTION, "trace-log");

    expect(h.logs.filter((l) => l.event === "turn_finished")).toEqual([
      expect.objectContaining({
        level: "info",
        trace_id: "trace-log",
        outcome: "answer",
        model: "claude-sonnet-4-5",
        prompt_version: "v1",
        repos: TEST_MANIFEST.repos.map(({ repository, commit }) => ({ repository, commit })),
        usage,
        cost_usd: 0.01,
        duration_ms: expect.any(Number),
      }),
    ]);
  });
});

describe("investigateTask", () => {
  it("opens the configured snapshot within SANDBOX_PROVISION_TIMEOUT_MS, with egress only to the model's API host", async () => {
    const h = harness({ SANDBOX_PROVISION_TIMEOUT_MS: "120000" });
    h.sandboxes.script(success());
    const domains: string[] = [];
    const opened: unknown[] = [];
    h.configureSandboxes = async (domain) => {
      domains.push(domain);
      return (name, opts) => {
        opened.push({ name, opts });
        return h.sandboxes.open(name, opts);
      };
    };

    await h.investigate({ transcript: QUESTION.transcript, trace_id: "t-open" });

    expect(domains).toEqual(["api.anthropic.com"]);
    expect(opened).toEqual([{ name: h.config.snapshotName, opts: { timeoutMs: 120_000 } }]);
  });

  it("keeps only evidence from the manifest, pinned to its full commit with a URL built by trusted code", async () => {
    const h = harness();
    h.sandboxes.script(success({
      ...answer,
      evidence: [
        { ...evidence, repository: "Render-OSS/CLI", commit: "c".repeat(7), url: "https://evil.example.com/x" },
        { ...evidence, repository: "evil/repo" },
        { ...evidence, repository: "render-oss/sdk", commit: "e".repeat(40) },
      ],
    }));

    const res = await h.investigate({ transcript: QUESTION.transcript, trace_id: "t-ev" });

    expect(res.kind === "result" && res.result.status === "final_answer" && res.result.evidence).toEqual([
      { ...evidence, url: `https://github.com/render-oss/cli/blob/${"c".repeat(40)}/cmd/deploy.go#L10-L24` },
    ]);
  });

  it("hands the runner the provider's key and logs investigation_failed with the runner's message, key redacted", async () => {
    const h = harness({ ANTHROPIC_API_KEY: MODEL_KEY });
    h.sandboxes.script({ events: [events.started(), events.error(`provider rejected ${MODEL_KEY}`)] });

    const res = await h.investigate({ transcript: QUESTION.transcript, trace_id: "t-fail" });

    expect(res).toEqual({ kind: "failed", code: "agent_error" });
    expect(h.sandboxes.runs[0]!.opts.modelApiKey).toBe(MODEL_KEY);
    expect(h.logs).toContainEqual(expect.objectContaining({
      level: "warn", event: "investigation_failed", trace_id: expect.any(String), code: "agent_error", message: "provider rejected [redacted]",
    }));
    expect(JSON.stringify(h.logs)).not.toContain(MODEL_KEY);
  });
});

describe("deliverCallback", () => {
  it("posts a verifiable signed body and rejects a non-2xx response so the deliver task retries", async () => {
    const secret = "test-secret-1234567890";
    const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(req.url === "/fail" ? 500 : 200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${(server.address() as { port: number }).port}`;
    const body = JSON.stringify({ trace_id: "t1", reply: { kind: "failure", traceId: "t1", reason: "test" } });
    try {
      await deliverCallback({ callback: { url: `${base}/hook`, secret }, body }, [base]);
      await expect(deliverCallback({ callback: { url: `${base}/fail`, secret }, body }, [base])).rejects.toThrow("500");
    } finally {
      server.close();
    }

    const { headers, body: sent } = received[0]!;
    expect(sent).toBe(body);
    expect(headers["content-type"]).toBe("application/json");
    expect(verifyCallback({
      secret,
      body: sent,
      signature: headers["x-researcher-signature"] as string,
      timestamp: headers["x-researcher-timestamp"] as string,
    })).toBe(true);
  });

  it("refuses an unapproved origin without sending anything", async () => {
    let received = 0;
    const server = createServer((_req, res) => { received++; res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    try {
      await expect(deliverCallback({ callback: { url, secret: "a".repeat(32) }, body: "{}" }, ["https://receiver.example"]))
        .rejects.toThrow("CALLBACK_ALLOWED_ORIGINS");
      expect(received).toBe(0);
    } finally {
      server.close();
    }
  });

  it("rejects a redirect without forwarding the signed body", async () => {
    let forwarded = 0;
    const target = createServer((_req, res) => { forwarded++; res.end(); });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const redirector = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as { port: number }).port}/capture` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(redirector.address() as { port: number }).port}`;
    try {
      await expect(deliverCallback({ callback: { url: `${origin}/hook`, secret: "a".repeat(32) }, body: "{}" }, [origin])).rejects.toThrow();
      expect(forwarded).toBe(0);
    } finally {
      target.close();
      redirector.close();
    }
  });
});

describe("callbackOrigins", () => {
  it("is empty when unset or blank, which disables callbacks", () => {
    expect(callbackOrigins({})).toEqual([]);
    expect(callbackOrigins({ CALLBACK_ALLOWED_ORIGINS: " " })).toEqual([]);
  });

  it("normalizes origins and matches every path on an exact origin only", () => {
    const origins = callbackOrigins({ CALLBACK_ALLOWED_ORIGINS: "https://Hooks.example:443/, https://events.example:8443" });
    expect(origins).toEqual(["https://hooks.example", "https://events.example:8443"]);
    expect(isApprovedCallback("https://hooks.example/a/b?c=1", origins)).toBe(true);
    for (const url of ["https://sub.hooks.example/", "https://hooks.example:8443/", "http://hooks.example/", "https://10.0.0.1/", "not a url"]) {
      expect(isApprovedCallback(url, origins), url).toBe(false);
    }
  });

  it.each(["https://hooks.example/path", "https://hooks.example?q=1", "https://user:pw@hooks.example", "http://hooks.example", "ftp://hooks.example", "nope"])(
    "rejects %s", (origin) => {
      expect(() => callbackOrigins({ CALLBACK_ALLOWED_ORIGINS: origin })).toThrow("CALLBACK_ALLOWED_ORIGINS");
    },
  );

  it("allows loopback HTTP only off Render", () => {
    expect(callbackOrigins({ CALLBACK_ALLOWED_ORIGINS: "http://localhost:4000" })).toEqual(["http://localhost:4000"]);
    expect(() => callbackOrigins({ CALLBACK_ALLOWED_ORIGINS: "http://localhost:4000", RENDER: "true" })).toThrow();
  });
});

describe("task timeouts", () => {
  it("give answer_question enough time for every investigate and deliver attempt", () => {
    const env = { AGENT_TIMEOUT_MS: "600000", SANDBOX_PROVISION_TIMEOUT_MS: "120000" };
    const investigate = investigateTimeoutSeconds(env);
    expect(investigate).toBeGreaterThan((600_000 + 120_000) / 1000);
    expect(parentTimeoutSeconds(env)).toBeGreaterThan(
      investigate * (INVESTIGATE_MAX_RETRIES + 1) + DELIVER_TIMEOUT_S * (DELIVER_MAX_RETRIES + 1),
    );
  });
});
