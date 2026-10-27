import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, ServerError, getUserAgent } from "@renderinc/sdk";
import { createLog } from "../src/log.ts";
import { SandboxClient, type RenderTimings } from "../src/sandbox/render/client.ts";
import { resolveWorkspaceId, type RenderConfig } from "../src/sandbox/render/config.ts";
import { openRenderSandbox } from "../src/sandbox/render/sandbox.ts";
import { investigateTask } from "../src/tasks.ts";
import { loadConfig } from "../src/workflow.ts";
import { FakeSandboxes } from "./fakes.ts";

const nativeFetch = globalThis.fetch;
const cfg: RenderConfig = {
  apiKey: "synthetic-render-key", workspaceId: "tea-test", hostCredentials: {},
  networkPolicy: { type: "allow-all" }, investigationTimeoutSeconds: 1800,
  builderTimeoutSeconds: 3600, minRequestIntervalMs: 0, sandboxDir: "sandbox",
};
const sandbox = { id: "sbx-test", status: "running", plan: "starter", networkPolicy: { type: "allow-all" }, region: "oregon", timeoutSeconds: 1800, createdAt: "" };
const json = (res: ServerResponse, value: unknown) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
};
let dispose = async () => {};
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await dispose(); });

async function fixture(controlDelayMs = 180, opts: {
  handle?: (path: string, res: ServerResponse, count: number) => boolean;
  timings?: Partial<RenderTimings>;
} = {}) {
  const requests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const aborted: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let origin: string;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const path = req.url!;
    requests.push({ path, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.on("close", () => { if (!res.writableEnded) aborted.push(path); });
    if (opts.handle?.(path, res, requests.length)) return;
    const respond = () => {
      if (path.includes("/token")) {
        const kind = path.includes("/runs/") ? "exec" : path.includes("/download/") ? "download" : "upload";
        json(res, { uri: `${origin}/data/${kind}`, method: kind === "download" ? "GET" : "POST", token: "synthetic-connect-token" });
      } else if (path.startsWith("/v1/")) json(res, sandbox);
      else if (path === "/data/exec") res.end('event: output\ndata: {"stream":"stdout","data":"ok"}\n\nevent: exit\ndata: {"exit_code":0}\n\n');
      else if (path === "/data/download") res.end("downloaded");
      else res.end();
    };
    if (path.startsWith("/v1/")) {
      const timer = setTimeout(() => { timers.delete(timer); respond(); }, controlDelayMs);
      timers.add(timer);
    } else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  dispose = async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    return nativeFetch(url.hostname === "api.render.com" ? new Request(`${origin}${url.pathname}${url.search}`, request) : request);
  });
  const logs: Record<string, unknown>[] = [];
  const client = SandboxClient.fromConfig(cfg, createLog({}, (line) => void logs.push(JSON.parse(line))), { requestTimeoutMs: 100, cleanupTimeoutMs: 40, pollMs: 1, ...opts.timings });
  return { client, requests, aborted, logs };
}

describe("real SDK control-plane deadlines", () => {
  it.each(["exec", "upload", "download", "create", "get", "terminate"] as const)("bounds %s before the delayed control response", async (method) => {
    const { client, requests, aborted } = await fixture();
    const signal = AbortSignal.timeout(30);
    const started = performance.now();
    const operation = method === "exec" ? client.exec("sbx-test", "true", { timeoutMs: 30 })
      : method === "upload" ? client.upload("sbx-test", "/input", "input", { signal })
      : method === "download" ? client.download("sbx-test", "/output", signal)
      : client.call<unknown>(() => method === "create" ? client.api.create({ timeoutSeconds: 1800 })
        : method === "get" ? client.api.get("sbx-test") : client.api.terminate("sbx-test"), { signal });
    await expect(operation).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(130);
    await sleep(10);
    expect(aborted.length).toBeGreaterThan(0);
    expect(requests.some(({ path }) => path.startsWith("/data/"))).toBe(false);
  });
});


describe("SDK transport lifecycle", () => {
  it("bounds control response-body reads and aborts their socket", async () => {
    const { client, aborted } = await fixture(0, { handle: (_path, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      return true;
    } });
    const started = performance.now();
    await expect(client.call(() => client.api.get("sbx-test"), { signal: AbortSignal.timeout(30) })).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(130);
    await sleep(10);
    expect(aborted).toHaveLength(1);
  });

  it("retains successful exec/transfers plus SDK auth, workspace, user-agent and local-dev isolation", async () => {
    vi.stubEnv("RENDER_USE_LOCAL_DEV", "true");
    vi.stubEnv("RENDER_LOCAL_DEV_URL", "http://127.0.0.1:1");
    const { client, requests } = await fixture(0);
    expect(await client.exec("sbx-test", "true", { timeoutMs: 100 })).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    await client.upload("sbx-test", "/input", "input");
    expect(await client.download("sbx-test", "/output")).toBe("downloaded");
    await client.create({ networkPolicy: cfg.networkPolicy });
    const control = requests.filter(({ path }) => path.startsWith("/v1/"));
    expect(control.every(({ headers }) => headers.authorization === `Bearer ${cfg.apiKey}` && headers["user-agent"] === getUserAgent())).toBe(true);
    expect(control.filter(({ path }) => path.includes("/token")).every(({ path }) => new URL(path, "http://test").searchParams.get("ownerId") === cfg.workspaceId)).toBe(true);
    expect(JSON.parse(control.at(-1)!.body)).toMatchObject({ ownerId: cfg.workspaceId, timeoutSeconds: 1800 });
    expect(requests.find(({ path }) => path === "/data/upload")?.body).toBe("input");
  });

  it("uses the independent cleanup budget for terminate and terminateQuietly", async () => {
    const { client, aborted, logs } = await fixture();
    const started = performance.now();
    await expect(client.terminate("sbx-test")).rejects.toThrow();
    await expect(client.terminateQuietly("sbx-test")).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(180);
    await sleep(10);
    expect(aborted).toHaveLength(2);
    expect(logs).toContainEqual(expect.objectContaining({ msg: "could not terminate sandbox" }));
  });

  it("cleans a known ID after provisioning expires without waiting indefinitely for cleanup", async () => {
    const { client, requests } = await fixture(180, { handle: (path, res) => {
      if (path === "/v1/sandboxes") { json(res, sandbox); return true; }
      return false;
    } });
    const started = performance.now();
    await expect(openRenderSandbox(client, "test-snapshot", { timeoutMs: 30 })).rejects.toThrow("within 30ms");
    expect(performance.now() - started).toBeLessThan(160);
    expect(requests.map(({ path }) => path.split("?")[0])).toEqual(["/v1/sandboxes", "/v1/sandboxes/sbx-test", "/v1/sandboxes/sbx-test/terminate"]);
  });

  it("keeps a late-ID observer and gives its cleanup a fresh signal", async () => {
    const { client, requests } = await fixture(0);
    const routedFetch = globalThis.fetch;
    let createSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/v1/sandboxes") {
        createSignal = request.signal;
        await sleep(80); // Deliberately emulate a transport which returns after cancellation.
        return Response.json(sandbox);
      }
      expect(request.signal.aborted).toBe(false);
      return routedFetch(request);
    });
    await expect(client.create({}, { signal: AbortSignal.timeout(20) })).rejects.toThrow();
    await sleep(100);
    expect(createSignal?.aborted).toBe(true);
    expect(requests.map(({ path }) => path.split("?")[0])).toEqual(["/v1/sandboxes/sbx-test/terminate"]);
  });

  it("does not retry an unknown create outcome and retains its provider timeout backstop", async () => {
    const { client, requests, logs } = await fixture();
    await expect(client.create({}, { signal: AbortSignal.timeout(30) })).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.body).timeoutSeconds).toBe(1800);
    expect(logs).toContainEqual(expect.objectContaining({ event: "sandbox_create_unknown" }));
  });

  it("retries known create rejection but preserves SDK error types for other failures", async () => {
    const { client, requests } = await fixture(0, { handle: (_path, res, count) => {
      if (count === 1) { res.statusCode = 429; json(res, { message: "try later" }); return true; }
      if (count === 3) { res.statusCode = 503; json(res, { message: "unavailable" }); return true; }
      if (count === 4) { res.statusCode = 404; json(res, { message: "not found" }); return true; }
      return false;
    } });
    expect((await client.create({})).id).toBe("sbx-test");
    expect(requests).toHaveLength(2);
    await expect(client.create({})).rejects.toBeInstanceOf(ServerError);
    expect(requests).toHaveLength(3);
    await expect(client.call(() => client.api.get("missing"), { retryOn: [] })).rejects.toBeInstanceOf(ClientError);
    expect(requests).toHaveLength(4);
  });

  it("prevents pre-aborted work and cancels a paced call before sending it", async () => {
    const { client, requests } = await fixture(0);
    const signal = AbortSignal.abort(new Error("already canceled"));
    await expect(client.create({}, { signal })).rejects.toThrow("already canceled");
    await expect(client.exec("sbx-test", "true", { timeoutMs: 100, signal })).rejects.toThrow("already canceled");
    await expect(client.upload("sbx-test", "/input", "input", { signal })).rejects.toThrow("already canceled");
    await expect(client.download("sbx-test", "/output", signal)).rejects.toThrow("already canceled");
    expect(requests).toEqual([]);
    client.cfg.minRequestIntervalMs = 50;
    try {
      await client.call(() => client.api.get("sbx-test"));
      await expect(client.call(() => client.api.get("sbx-test"), { signal: AbortSignal.timeout(10) })).rejects.toThrow();
      await sleep(60);
      expect(requests).toHaveLength(1);
    } finally { client.cfg.minRequestIntervalMs = 0; }
  });

  it("keeps concurrent request signals separate", async () => {
    const { client, requests } = await fixture(50);
    const short = client.call(() => client.api.get("short"), { signal: AbortSignal.timeout(20) });
    const long = client.call(() => client.api.get("long"), { signal: AbortSignal.timeout(100) });
    await expect(short).rejects.toThrow();
    await expect(long).resolves.toMatchObject({ id: "sbx-test" });
    expect(requests).toHaveLength(2);
  });


  it("returns an already computed investigation result after cleanup times out", async () => {
    const { client, requests } = await fixture();
    const sandboxes = new FakeSandboxes().script({ events: [{
      type: "result", at: new Date().toISOString(),
      result: { status: "needs_clarification", question: "Which version?", why_needed: "It changed" },
    }] });
    const started = performance.now();
    const result = await investigateTask({
      config: loadConfig(), log: createLog({}, () => {}),
      configureSandboxes: async () => async (name, options) => {
        const opened = await sandboxes.open(name, options);
        return { ...opened, close: () => client.terminate(opened.id) };
      },
    }, { trace_id: "test", transcript: [{ role: "user", text: "How does it work?" }] });
    expect(result).toMatchObject({ kind: "result", result: { status: "needs_clarification" } });
    expect(performance.now() - started).toBeLessThan(160);
    expect(requests).toHaveLength(1);
  });

  it.each(["exec", "upload", "download"] as const)("retains the %s data-plane deadline after token acquisition", async (method) => {
    const { client, aborted } = await fixture(0, { handle: (path, res) => {
      if (!path.startsWith("/data/")) return false;
      if (method !== "upload") { res.writeHead(200); res.write("partial"); }
      return true;
    } });
    const signal = AbortSignal.timeout(30);
    const started = performance.now();
    const operation = method === "exec" ? client.exec("sbx-test", "true", { timeoutMs: 30 })
      : method === "upload" ? client.upload("sbx-test", "/input", "input", { signal })
      : client.download("sbx-test", "/output", signal);
    await expect(operation).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(130);
    await sleep(10);
    expect(aborted.some((path) => path.startsWith("/data/"))).toBe(true);
  });

  it("bounds snapshot control requests and default waits without a supplied operation signal", async () => {
    const { client, aborted } = await fixture(180, { timings: { requestTimeoutMs: 35 } });
    const started = performance.now();
    await expect(client.call(() => client.api.snapshots.get({ sandboxGroupId: "sbg-test", snapshotId: "snp-test" }))).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(130);
    await sleep(10);
    expect(aborted).toHaveLength(1);
  });

  it.each(["exec", "upload", "download"] as const)("starts no %s transfer after a late token response", async (method) => {
    const { client, requests } = await fixture(70);
    const routedFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      // Deliberately ignore cancellation of token acquisition; the SDK data-plane signal must still stop work.
      return routedFetch(new URL(request.url).pathname.endsWith("/token")
        ? new Request(request, { signal: new AbortController().signal }) : request);
    });
    const signal = AbortSignal.timeout(20);
    const operation = method === "exec" ? client.exec("sbx-test", "true", { timeoutMs: 20 })
      : method === "upload" ? client.upload("sbx-test", "/input", "input", { signal })
      : client.download("sbx-test", "/output", signal);
    await expect(operation).rejects.toThrow();
    await sleep(100);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toContain("/token");
  });

  it("cancels retry backoff without issuing another request", async () => {
    const { client, requests } = await fixture(0, { timings: { pollMs: 60 }, handle: (_path, res) => {
      res.statusCode = 503; json(res, { message: "unavailable" }); return true;
    } });
    await expect(client.call(() => client.api.get("sbx-test"), { retryOn: [503], signal: AbortSignal.timeout(30) })).rejects.toThrow();
    await sleep(70);
    expect(requests).toHaveLength(1);
  });

  it("also bounds automatic workspace lookup, including a stalled response body", async () => {
    let bodyStarted = false;
    const { aborted } = await fixture(0, { handle: (_path, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
      bodyStarted = true;
      return true;
    } });
    const controller = new AbortController();
    const lookup = resolveWorkspaceId(cfg.apiKey, fetch, controller.signal);
    await vi.waitFor(() => expect(bodyStarted).toBe(true), { timeout: 1000, interval: 5 });
    const started = performance.now();
    controller.abort(new Error("workspace lookup canceled"));
    await expect(lookup).rejects.toThrow("workspace lookup canceled");
    expect(performance.now() - started).toBeLessThan(500);
    await vi.waitFor(() => expect(aborted).toHaveLength(1), { timeout: 1000, interval: 5 });
  });
});
