import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientError } from "@renderinc/sdk";
import { createApp, loadEnv, toQuestionId, type AppDeps, type GetTaskRun } from "../src/api.ts";
import { signCallback, verifyCallback } from "../src/callback.ts";
import { createLog } from "../src/log.ts";
import type { StartQuestion } from "../src/question.ts";

const TOKEN = "test-api-token-1234";
const QUESTION_ID_SECRET = "test-question-id-secret-1234567890";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { "content-type": "application/json", ...AUTH };
const qid = (runId: string) => toQuestionId(QUESTION_ID_SECRET, runId);
const question = "How does deploy retry?";

function harness(overrides: Partial<AppDeps> = {}) {
  const started: Array<{ input: unknown; key?: string }> = [];
  const lookups: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const startQuestion: StartQuestion = async (input, opts) => {
    started.push({ input, key: opts.idempotencyKey });
    return { id: "run-123" };
  };
  const getTaskRun: GetTaskRun = async (id) => {
    lookups.push(id);
    return { status: "running", results: [] };
  };
  const app = createApp({
    apiToken: TOKEN,
    questionIdSecret: QUESTION_ID_SECRET,
    startQuestion,
    getTaskRun,
    isLocalDev: false,
    log: createLog({}, (line) => void logs.push(JSON.parse(line))),
    ...overrides,
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/v1/questions", {
      method: "POST",
      headers: { ...JSON_AUTH, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (id: string) => app.request(`/v1/questions/${id}`, { headers: AUTH });
  return { app, started, lookups, logs, post, get };
}

const withRun = (run: Awaited<ReturnType<GetTaskRun>>) => harness({ getTaskRun: async () => run });

describe("HTTP API", () => {
  it("serves /healthz without auth", async () => {
    const res = await harness().app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("requires the bearer token on /v1/*", async () => {
    const { app, started } = harness();
    for (const headers of [{}, { Authorization: "Bearer wrong-token" }]) {
      const post = await app.request("/v1/questions", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ question }),
      });
      expect(post.status).toBe(401);
      expect((await app.request(`/v1/questions/${qid("run-1")}`, { headers })).status).toBe(401);
    }
    expect(started).toEqual([]);
  });

  it("starts a question and returns 202 with a signed question id, passing the idempotency key", async () => {
    const { post, started, logs } = harness();
    const res = await post({ question, metadata: { ticket: "T-1" } }, { "Idempotency-Key": "idem-1" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: qid("run-123") });
    expect(started).toEqual([{ input: { transcript: [{ role: "user", text: question }], metadata: { ticket: "T-1" } }, key: "idem-1" }]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "task_started", run_id: "run-123" }));
  });

  it("rejects invalid bodies with 400 without starting a run", async () => {
    const { post, started } = harness();
    const cases: Record<string, unknown> = {
      "malformed JSON": "{not json",
      "missing question": {},
      "blank question": { question: "  " },
      "question over 8000 chars": { question: "x".repeat(8001) },
      "more than 16 metadata keys": { question, metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])) },
      "callback secret under 16 chars": { question, callback: { url: "https://example.com/hook", secret: "short" } },
    };
    for (const [name, body] of Object.entries(cases)) {
      expect((await post(body)).status, name).toBe(400);
    }
    expect(started).toEqual([]);
  });

  it("continues an earlier question: its transcript, then its reply as the agent's turn, then the new question", async () => {
    const earlier = [{ role: "user", text: "How does deploy retry?" }];
    const reply = { kind: "clarification", traceId: "t1", result: { status: "needs_clarification", question: "Which CLI version?", why_needed: "It changed in v2." } };
    const lookups: string[] = [];
    const { post, started } = harness({
      getTaskRun: async (id) => {
        lookups.push(id);
        return { status: "completed", input: [{ transcript: earlier }], results: [{ trace_id: "t1", reply }] };
      },
    });

    const res = await post({ question: "v2.3", follow_up_to: qid("run-1") });

    expect(res.status).toBe(202);
    expect(lookups).toEqual(["run-1"]);
    expect(started[0]!.input).toMatchObject({
      transcript: [...earlier, { role: "agent", text: "Which CLI version?" }, { role: "user", text: "v2.3" }],
    });
  });

  it("refuses a follow-up to an unknown, unfinished, or overlong conversation", async () => {
    const running = withRun({ status: "running", results: [] });
    expect((await running.post({ question, follow_up_to: qid("run-1") })).status).toBe(409);
    expect((await running.post({ question, follow_up_to: "trn-forged.AAAAAAAAAAAAAAAAAAAAAA" })).status).toBe(404);

    const reply = { kind: "failure", traceId: "t1", reason: "it timed out" };
    const full = Array.from({ length: 199 }, () => ({ role: "user", text: "hi" }));
    const long = withRun({ status: "completed", input: [{ transcript: full }], results: [{ reply }] });
    const res = await long.post({ question, follow_up_to: qid("run-1") });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining("at most 200 messages") });
    expect(running.started).toEqual([]);
    expect(long.started).toEqual([]);
  });

  it("requires an https callback URL, allowing http://localhost only in local dev", async () => {
    const secret = "a".repeat(32);
    const prod = harness();
    expect((await prod.post({ question, callback: { url: "http://example.com/hook", secret } })).status).toBe(400);
    expect((await prod.post({ question, callback: { url: "http://localhost:4000/hook", secret } })).status).toBe(400);
    expect((await prod.post({ question, callback: { url: "https://example.com/hook", secret } })).status).toBe(202);

    const local = harness({ isLocalDev: true });
    expect((await local.post({ question, callback: { url: "http://localhost:4000/hook", secret } })).status).toBe(202);
    expect((await local.post({ question, callback: { url: "http://example.com/hook", secret } })).status).toBe(400);
  });

  it("maps the run status to running, completed (with the reply), or failed", async () => {
    const id = qid("run-1");
    const reply = { kind: "clarification", traceId: "t1", result: { status: "needs_clarification", question: "Which region?", why_needed: "It varies." } };
    const cases: Array<[Awaited<ReturnType<GetTaskRun>>, unknown]> = [
      [{ status: "pending", results: [] }, { id, status: "running" }],
      [{ status: "running", results: [] }, { id, status: "running" }],
      [{ status: "paused", results: [] }, { id, status: "running" }],
      [{ status: "succeeded", results: [{ trace_id: "t1", reply }] }, { id, status: "completed", trace_id: "t1", reply }],
      [{ status: "completed", results: [{ trace_id: "t1", reply }] }, { id, status: "completed", trace_id: "t1", reply }],
      [{ status: "stopped", results: [] }, { id, status: "failed", error: "The investigation could not be completed.", trace_id: "run-1" }],
      [{ status: "failed", results: [], error: "timeout" }, { id, status: "failed", error: "The investigation could not be completed.", trace_id: "run-1" }],
      [{ status: "canceled", results: [] }, { id, status: "failed", error: "The investigation could not be completed.", trace_id: "run-1" }],
    ];
    for (const [run, expected] of cases) {
      const res = await withRun(run).get(id);
      expect(res.status, run.status).toBe(200);
      expect(await res.json(), run.status).toEqual(expected);
    }
  });

  it("accepts issued question IDs for polling and follow-up without exposing the signing secret", async () => {
    const { post, get, started, logs } = withRun({
      status: "completed",
      input: [{ transcript: [{ role: "user", text: question }] }],
      results: [{ reply: { kind: "failure", traceId: "t1", reason: "test reply" } }],
    });
    const issued = await (await post({ question })).json() as { id: string };
    expect((await get(issued.id)).status).toBe(200);
    expect((await post({ question: "Please explain", follow_up_to: issued.id })).status).toBe(202);
    expect(JSON.stringify({ issued, started, logs })).not.toContain(QUESTION_ID_SECRET);
  });

  it("keeps issued IDs valid after bearer rotation when the signing secret stays fixed", async () => {
    const issued = await (await harness().post({ question })).json() as { id: string };
    const rotatedToken = "rotated-api-token-5678";
    const rotated = harness({ apiToken: rotatedToken });
    expect((await rotated.app.request(`/v1/questions/${issued.id}`, { headers: AUTH })).status).toBe(401);
    expect((await rotated.app.request(`/v1/questions/${issued.id}`, {
      headers: { Authorization: `Bearer ${rotatedToken}` },
    })).status).toBe(200);
    expect(rotated.lookups).toEqual(["run-123"]);
  });

  it("invalidates issued IDs after signing-secret rotation before any workflow access", async () => {
    const issued = await (await harness().post({ question })).json() as { id: string };
    const rotated = harness({ questionIdSecret: "rotated-question-id-secret-12345678" });
    expect((await rotated.get(issued.id)).status).toBe(404);
    expect((await rotated.post({ question, follow_up_to: issued.id })).status).toBe(404);
    expect(rotated.lookups).toEqual([]);
    expect(rotated.started).toEqual([]);
  });

  it("rejects question IDs forged with the caller's bearer token before any workflow access", async () => {
    const lookups: string[] = [];
    const { get, post, started } = harness({
      getTaskRun: async (id) => {
        lookups.push(id);
        return {
          status: "completed",
          input: [{ transcript: [{ role: "user", text: question }] }],
          results: [{ reply: { kind: "failure", traceId: "t1", reason: "test reply" } }],
        };
      },
    });
    const runId = "trn-unrelated";
    const mac = createHmac("sha256", TOKEN).update(`question-id:${runId}`).digest("base64url").slice(0, 22);
    const forgedId = `${runId}.${mac}`;

    const statuses = [
      (await get(forgedId)).status,
      (await post({ question, follow_up_to: forgedId })).status,
    ];

    expect(statuses).toEqual([404, 404]);
    expect(lookups).toEqual([]);
    expect(started).toEqual([]);
  });

  it("only reads runs this API started: raw, forged, foreign-signed, or unknown ids are 404", async () => {
    const { get, lookups } = harness();
    for (const id of ["trn-other", "trn-other.AAAAAAAAAAAAAAAAAAAAAA", toQuestionId("a-different-signing-secret-12345678", "trn-other")]) {
      expect((await get(id)).status, id).toBe(404);
    }
    expect(lookups).toEqual([]);
    await get(qid("trn-mine"));
    expect(lookups).toEqual(["trn-mine"]);

    const unknown = harness({ getTaskRun: async () => { throw new ClientError("not found", 404); } });
    expect((await unknown.get(qid("missing"))).status).toBe(404);
  });

  it("turns unexpected errors into a logged 500", async () => {
    const { post, get, logs } = harness({
      startQuestion: async () => { throw new Error("boom"); },
      getTaskRun: async () => { throw new ClientError("forbidden", 403); },
    });
    const postRes = await post({ question });
    expect(postRes.status).toBe(500);
    expect(await postRes.text()).toBe("internal error");
    expect((await get(qid("r"))).status).toBe(500);
    expect(logs).toContainEqual(expect.objectContaining({ level: "error", event: "request_failed", method: "POST", error: "boom" }));
    expect(logs).toContainEqual(expect.objectContaining({ level: "error", event: "request_failed", method: "GET" }));
  });

  it.each(["failed", "canceled"])("keeps %s workflow diagnostics private and returns the verified run correlation", async (status) => {
    const marker = "SYNTHETIC_TASK_DIAGNOSTIC_NOT_FOR_CALLERS";
    const runId = "run-safe-failure";
    const { get, logs } = harness({ getTaskRun: async () => ({
      status, error: marker, input: [{ internal: marker }], results: [{ trace_id: "untrusted-result-trace", internal: marker }],
    }) });
    const res = await get(qid(runId));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(marker);
    expect(JSON.parse(body)).toEqual({
      id: qid(runId), status: "failed", error: "The investigation could not be completed.", trace_id: runId,
    });
    expect(JSON.stringify(logs)).not.toContain(marker);
  });

  it.each(["succeeded", "completed"])("preserves the %s response when no result was recorded", async (status) => {
    const id = qid("run-empty-result");
    const res = await withRun({ status, results: [] }).get(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: "completed" });
  });
});

describe("optional web UI", () => {
  const web = {
    password: "test-web-password",
    sessionSecret: "test-web-session-secret-1234567890",
    distDir: "unused",
  };

  it("is absent unless configured", async () => {
    const { app } = harness();
    expect((await app.request("/api/session")).status).toBe(404);
    expect((await app.request("/")).status).toBe(404);
  });

  it("authenticates with an HTTP-only session without exposing the bearer token", async () => {
    const { app, started } = harness({ web });
    expect(await (await app.request("/api/session")).json()).toEqual({ authenticated: false });
    expect((await app.request("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    })).status).toBe(401);

    const wrong = await app.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.1" },
      body: JSON.stringify({ password: "not-the-password" }),
    });
    expect(wrong.status).toBe(401);

    const login = await app.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ password: web.password }),
    });
    expect(login.status).toBe(204);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("researcher_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toContain(TOKEN);
    const cookie = setCookie.split(";", 1)[0]!;

    expect(await (await app.request("/api/session", { headers: { cookie } })).json()).toEqual({ authenticated: true });
    const start = await app.request("/api/questions", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    expect(start.status).toBe(202);
    expect(started).toHaveLength(1);
    const unknownWeb = await app.request("/api/not-a-route", { headers: { cookie } });
    expect(unknownWeb.status).toBe(404);
    expect(unknownWeb.headers.get("content-type")).toContain("application/json");
    const unknownApi = await app.request("/v1/not-a-route", { headers: AUTH });
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.headers.get("content-type")).toContain("application/json");
  });

  it("serves the single-page app only when the UI is enabled", async () => {
    const distDir = await mkdtemp(join(tmpdir(), "researcher-web-"));
    try {
      await writeFile(join(distDir, "index.html"), "<main>Researcher UI</main>");
      const { app } = harness({ web: { ...web, distDir } });
      const root = await app.request("/");
      expect(root.status).toBe(200);
      expect(await root.text()).toContain("Researcher UI");
      const route = await app.request("/questions/local-id");
      expect(route.status).toBe(200);
      expect(await route.text()).toContain("Researcher UI");
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });
});

describe("signCallback / verifyCallback", () => {
  it("accepts its own signature and rejects tampered, foreign, stale, or missing ones", () => {
    const secret = "test-callback-secret-1234567890";
    const body = '{"id":"r1","reply":{"kind":"failure"}}';
    const { signature, timestamp } = signCallback(secret, body);
    expect(verifyCallback({ secret, signature, timestamp, body })).toBe(true);
    expect(verifyCallback({ secret, signature, timestamp: String(timestamp), body })).toBe(true);

    const stale = signCallback(secret, body, timestamp - 600);
    for (const [name, opts] of Object.entries({
      "tampered body": { signature, timestamp, body: body.replace("r1", "r2") },
      "other secret": { ...signCallback("another-secret-1234567890", body, timestamp), body },
      "stale timestamp": { ...stale, body },
      "missing signature": { signature: undefined, timestamp, body },
      "missing timestamp": { signature, timestamp: undefined, body },
    })) {
      expect(verifyCallback({ secret, ...opts }), name).toBe(false);
    }
  });
});

describe("loadEnv", () => {
  it("requires a server-only question-ID secret of at least 32 characters, distinct from API_TOKEN", () => {
    const base = { API_TOKEN: TOKEN, RENDER_API_KEY: "rk" };
    for (const secret of [undefined, "", " ", "s".repeat(31)]) {
      expect(() => loadEnv({ ...base, QUESTION_ID_SECRET: secret })).toThrow(/QUESTION_ID_SECRET/);
    }
    expect(() => loadEnv({ ...base, API_TOKEN: QUESTION_ID_SECRET, QUESTION_ID_SECRET })).toThrow(/must differ from API_TOKEN/);
    expect(loadEnv({ ...base, QUESTION_ID_SECRET }).questionIdSecret).toBe(QUESTION_ID_SECRET);
  });

  it("requires API_TOKEN, and RENDER_API_KEY unless running against local dev", () => {
    expect(() => loadEnv({ QUESTION_ID_SECRET, RENDER_API_KEY: "rk" })).toThrow();
    expect(() => loadEnv({ QUESTION_ID_SECRET, API_TOKEN: "tok" })).toThrow(/RENDER_API_KEY is required/);
    expect(loadEnv({ QUESTION_ID_SECRET, API_TOKEN: "tok", RENDER_LOCAL_DEV_URL: "http://localhost:8121" }).localDevUrl).toBe("http://localhost:8121");
  });

  it("treats blank Dashboard values as unset and derives the task slug from WORKFLOW_SLUG", () => {
    expect(() => loadEnv({ QUESTION_ID_SECRET, API_TOKEN: "tok", RENDER_API_KEY: "", RENDER_LOCAL_DEV_URL: " " })).toThrow(/RENDER_API_KEY is required/);
    expect(loadEnv({ QUESTION_ID_SECRET, API_TOKEN: "tok", RENDER_API_KEY: "rk" }).taskSlug).toBe("codebase-researcher-workflow/answer_question");
    expect(loadEnv({ QUESTION_ID_SECRET, API_TOKEN: "tok", RENDER_API_KEY: "rk", WORKFLOW_SLUG: "my-wf" }).taskSlug).toBe("my-wf/answer_question");
  });

  it("enables the web UI only with a password and server-side session secret", () => {
    const base = { QUESTION_ID_SECRET, API_TOKEN: "tok", RENDER_API_KEY: "rk" };
    expect(loadEnv(base).web).toBeUndefined();
    expect(() => loadEnv({ ...base, WEB_PASSWORD: "a-secure-password" })).toThrow(/WEB_SESSION_SECRET/);
    expect(loadEnv({ ...base, WEB_SESSION_SECRET: "s".repeat(32) }).web).toBeUndefined();
    expect(loadEnv({
      ...base,
      WEB_PASSWORD: "a-secure-password",
      WEB_SESSION_SECRET: "s".repeat(32),
      WEB_DIST_DIR: "/tmp/researcher-ui",
    }).web).toEqual({
      password: "a-secure-password",
      sessionSecret: "s".repeat(32),
      distDir: "/tmp/researcher-ui",
    });
  });
});
