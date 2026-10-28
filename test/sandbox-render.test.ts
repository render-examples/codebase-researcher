import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoManifest } from "../src/manifest.ts";
import { AbortError, RenderError, SandboxSnapshotNotFoundError, SandboxSnapshotNotReadyError } from "@renderinc/sdk";
import type { SandboxExecEvent } from "@renderinc/sdk/experimental";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureSandboxes } from "../src/sandbox/index.ts";
import { SandboxMisconfiguredError, SnapshotUnavailableError } from "../src/sandbox/interface.ts";
import { ClientError } from "@renderinc/sdk";
import { SandboxClient, type SandboxApi } from "../src/sandbox/render/client.ts";
import { loadRenderConfig, type NetworkPolicy, type RenderConfig } from "../src/sandbox/render/config.ts";
import { openRenderSandbox, runInvestigation } from "../src/sandbox/render/sandbox.ts";
import { buildSnapshot, pruneSnapshots, resolveHeads } from "../src/sandbox/render/snapshot.ts";
import { runnerInput } from "./helpers.ts";
import { createLog } from "../src/log.ts";
import { captureRun, classifyRun } from "../src/tasks.ts";

const GH_TOKEN = "ghp_renderProviderSecret000000000000";
const MODEL_KEY = "sk-ant-api03-renderProviderSecret";
const LAYOUT = { reposRoot: "/opt/researcher/repos", scratchDir: "/opt/researcher/scratch" };
const NAME = "codebase-researcher-corpus";
const profile = { name: "default", repos: [{ repository: "render-oss/cli" }, { repository: "acme/api", branch: "main" }] };
const heads: RepoManifest["repos"] = [
  { repository: "render-oss/cli", branch: "main", commit: "1".repeat(40), path: "render-oss/cli" },
  { repository: "acme/api", branch: "main", commit: "2".repeat(40), path: "acme/api" },
];

type Call =
  | { op: "create"; id: string; input: Parameters<SandboxApi["create"]>[0] }
  | { op: "exec"; id: string; command: string }
  | { op: "upload"; id: string; path: string; data: unknown }
  | { op: "download" | "terminate"; id: string; path?: string }
  | { op: "snapshot.create" | "snapshot.get" | "snapshot.list" | "snapshot.delete"; input?: unknown };

type ExecHandler = (id: string, command: string, signal?: AbortSignal) => SandboxExecEvent[] | AsyncGenerator<SandboxExecEvent>;

const out = (data: string, stream: "stdout" | "stderr" = "stdout"): SandboxExecEvent => ({ type: "output", stream, data });
const exit = (code = 0): SandboxExecEvent => ({ type: "exit", exit_code: code });
const info = (overrides: object = {}) =>
  JSON.stringify({
    runAs: "investigator",
    uid: 0,
    drop: "setpriv",
    node: "v24.14.1",
    runnerNonDumpable: true,
    dnsResolves: true,
    selfTest: { ok: true, pi_version: "0.83.0", prompt_version: "v3" },
    ...overrides,
  });

/** In-memory stand-in for the SDK's SandboxesClient that records every call. */
class FakeApi {
  calls: Call[] = [];
  createError?: (input: Parameters<SandboxApi["create"]>[0]) => Error | undefined;
  /** The policy `create` reports; defaults to echoing the requested one. */
  createdPolicy?: unknown;
  exec_: ExecHandler = () => [exit(0)];
  /** Contents of sandbox files other than manifest.json; undefined means the download fails. */
  file_: (path: string) => string | undefined = () => undefined;
  status: "creating" | "running" | "terminated" = "running";
  manifest = (): RepoManifest => ({
    profile: "default",
    created_at: new Date().toISOString(),
    repos: heads.map((h) => ({ ...h, path: `/opt/researcher/repos/${h.repository}` })),
  });
  #n = 0;

  api(): SandboxApi {
    const self = this;
    return {
      async create(input = {}) {
        const err = self.createError?.(input);
        if (err) throw err;
        const id = `sbx-${++self.#n}`;
        self.calls.push({ op: "create", id, input });
        return {
          id,
          status: "creating",
          plan: "starter",
          networkPolicy: (self.createdPolicy ?? input.networkPolicy ?? { type: "allow-all" }) as NonNullable<typeof input.networkPolicy>,
          region: "oregon",
          timeoutSeconds: input.timeoutSeconds ?? 7200,
          createdAt: new Date().toISOString(),
        };
      },
      async get(id) {
        return { id, status: self.status, plan: "starter", networkPolicy: { type: "allow-all" }, region: "oregon", timeoutSeconds: 1, createdAt: "" };
      },
      async exec(id, command, _ownerId, signal) {
        self.calls.push({ op: "exec", id, command });
        if (signal?.aborted) throw new AbortError();
        const events = self.exec_(id, command, signal);
        return Array.isArray(events) ? (async function* () { yield* events; })() : events;
      },
      async upload(id, path, data) {
        self.calls.push({ op: "upload", id, path, data });
      },
      async download(id, path) {
        self.calls.push({ op: "download", id, path });
        const text = path.endsWith("/manifest.json") ? JSON.stringify(self.manifest()) : self.file_(path);
        if (text === undefined) throw new Error(`no such file: ${path}`);
        const data = Buffer.from(text);
        return { data, size: data.length };
      },
      async terminate(id) {
        self.calls.push({ op: "terminate", id });
      },
      snapshots: {
        async create(input) {
          self.calls.push({ op: "snapshot.create", input });
          return snapshot("snp-new", "creating", input.name);
        },
        async get(input) {
          self.calls.push({ op: "snapshot.get", input });
          return snapshot(input.snapshotId, "available", NAME);
        },
        async list(input) {
          self.calls.push({ op: "snapshot.list", input });
          return [];
        },
        async delete(input) {
          self.calls.push({ op: "snapshot.delete", input });
        },
      },
    } as SandboxApi;
  }

  commands(): string[] {
    return this.calls.flatMap((c) => (c.op === "exec" ? [c.command] : []));
  }

  inputs(op: Call["op"]): unknown[] {
    return this.calls.flatMap((c) => (c.op === op && "input" in c ? [c.input] : []));
  }

  terminated(): string[] {
    return this.calls.flatMap((c) => (c.op === "terminate" ? [c.id] : []));
  }

  indexOf(pred: (c: Call) => boolean): number {
    return this.calls.findIndex(pred);
  }
}

function snapshot(id: string, status: "creating" | "available" | "failed", name?: string) {
  return {
    id,
    sandboxGroupId: "sbg-1",
    sourceSandboxId: "sbx-1",
    name: name ?? null,
    kind: "filesystem" as const,
    status,
    plan: "starter" as const,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

let fake: FakeApi;
let logs: Record<string, unknown>[];
const silent = createLog({}, () => {});
const SANDBOX_DIR = fileURLToPath(new URL("../sandbox/", import.meta.url));
const OPEN = { timeoutMs: 60_000 };

function client(
  policy: NetworkPolicy = {
    type: "allow-list",
    rules: [{ domain: "api.anthropic.com", protocol: "https" }],
  },
  api = fake.api(),
) {
  const cfg: RenderConfig = {
    apiKey: "rnd_test",
    workspaceId: "tea-test",
    hostCredentials: { "github.com": { username: "x-access-token", token: GH_TOKEN } },
    networkPolicy: policy,
    investigationTimeoutSeconds: 1_800,
    builderTimeoutSeconds: 3_600,
    minRequestIntervalMs: 0,
    sandboxDir: SANDBOX_DIR,
  };
  const log = createLog({}, (line) => void logs.push(JSON.parse(line)));
  return new SandboxClient(api, cfg, log, { pollMs: 1, bootTimeoutMs: 1_000, investigationGraceMs: 30_000 });
}

beforeEach(() => {
  fake = new FakeApi();
  logs = [];
});

const prepareExec: ExecHandler = (_id, command) => {
  if (command.includes("verify.sh")) return [out("progress noise\n", "stderr"), out(`${info()}\n`), exit(0)];
  if (command.includes('printf "%s')) return [out("/opt/researcher/app/node/bin/node\nsetpriv\n"), exit(0)];
  return [exit(0)];
};

const dumpableExec: ExecHandler = (id, command) =>
  command.includes("verify.sh") ? [out(`${info({ runnerNonDumpable: false })}\n`), exit(0)] : prepareExec(id, command);

describe("buildSnapshot", () => {
  it("snapshots an allow-all builder, uploading credentials only after third-party code ran and never in a command", async () => {
    fake.exec_ = prepareExec;
    const built = await buildSnapshot(client(), { profile, heads, snapshotName: NAME });

    expect(built).toEqual({ id: "snp-new", sandboxGroupId: "sbg-1" });
    const [builder] = fake.calls.filter((c) => c.op === "create");
    expect(builder!.input).toMatchObject({ networkPolicy: { type: "allow-all" } });
    expect(fake.inputs("snapshot.create")).toEqual([{ sandboxId: builder!.id, kind: "filesystem", name: NAME }]);
    expect(fake.terminated()).toEqual([builder!.id]);

    const credUpload = fake.indexOf((c) => c.op === "upload" && c.path.includes("/creds/"));
    const exec = (s: string) => fake.indexOf((c) => c.op === "exec" && c.command.includes(s));
    expect(fake.calls[credUpload]).toMatchObject({ data: `x-access-token\n${GH_TOKEN}` });
    expect(exec("install-tools.sh")).toBeLessThan(credUpload);
    expect(exec("--self-test")).toBeLessThan(credUpload);
    expect(fake.commands().some((c) => c.includes(GH_TOKEN))).toBe(false);

    const snapshotted = fake.indexOf((c) => c.op === "snapshot.create");
    expect(exec("scrub-credentials.sh")).toBeLessThan(snapshotted);
    expect(fake.indexOf((c) => c.op === "exec" && c.command === "rm -rf /tmp/researcher-stage")).toBeLessThan(snapshotted);

    const manifest = fake.calls.find((c) => c.op === "upload" && c.path === "/opt/researcher/app/manifest.json") as { data: string };
    expect(JSON.parse(manifest.data).repos.map((r: { repository: string; commit: string }) => [r.repository, r.commit]))
      .toEqual(heads.map((h) => [h.repository, h.commit]));
  });

  it("never uploads credentials when installing tools fails, and terminates the builder", async () => {
    fake.exec_ = (id, command) => (command.includes("install-tools.sh") ? [exit(1)] : prepareExec(id, command));
    await expect(buildSnapshot(client(), { profile, heads, snapshotName: NAME })).rejects.toThrow("install-tools.sh");
    expect(fake.calls.some((c) => c.op === "upload" && c.path.includes("/creds/"))).toBe(false);
    expect(fake.calls.some((c) => c.op === "snapshot.create")).toBe(false);
    expect(fake.terminated()).toEqual(["sbx-1"]);
  });

  it("fails without snapshotting when the builder can't confirm the runner is non-dumpable", async () => {
    fake.exec_ = dumpableExec;
    await expect(buildSnapshot(client(), { profile, heads, snapshotName: NAME })).rejects.toThrow("non-dumpable");
    expect(fake.calls.some((c) => c.op === "snapshot.create")).toBe(false);
    expect(fake.terminated()).toEqual(["sbx-1"]);
  });
});

describe("resolveHeads", () => {
  const sha = "a".repeat(40);

  async function lsRemote(url: string, hostCreds: RenderConfig["hostCredentials"]) {
    const dir = await mkdtemp(join(tmpdir(), "resolve-heads-"));
    try {
      const record = join(dir, "record");
      await writeFile(join(dir, "git"), `#!/bin/sh
env | grep '^RESEARCHER_TOKEN_' > ${record}
printf 'ref: refs/heads/main\\tHEAD\\n${sha}\\tHEAD\\n'
`, { mode: 0o755 });
      vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
      const heads = await resolveHeads({ name: "test", repos: [{ repository: "acme/repo", url }] }, hostCreds);
      return { heads, tokens: (await readFile(record, "utf8")).trim() };
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("selects the credential for a nondefault HTTPS port, matching the staged clone helper's host:port key", async () => {
    const { heads, tokens } = await lsRemote("https://git.example:8443/acme/repo.git", {
      "git.example": { username: "x", token: "default-port-token" },
      "git.example:8443": { username: "x", token: "port-token" },
    });
    expect(heads[0]).toMatchObject({ commit: sha, branch: "main" });
    expect(tokens).toBe("RESEARCHER_TOKEN_GIT_EXAMPLE_8443=port-token");
  });

  it("does not reuse a default-port credential for another port", async () => {
    const { tokens } = await lsRemote("https://git.example:8443/acme/repo.git", { "git.example": { username: "x", token: "t" } });
    expect(tokens).toBe("");
  });
});

describe("pruneSnapshots", () => {
  const built = { id: "snp-new", sandboxGroupId: "sbg-1" };

  it("retains the two available snapshots when recent failed captures are interleaved", async () => {
    const api = fake.api();
    api.snapshots.list = async () => [
      { snapshot: { ...snapshot("new-good", "available", NAME), requestedAt: "2026-10-27T03:00:00Z" }, cursor: "a" },
      { snapshot: { ...snapshot("recent-failure", "failed", NAME), requestedAt: "2026-10-27T02:30:00Z" }, cursor: "b" },
      { snapshot: { ...snapshot("older-failure", "failed", NAME), requestedAt: "2026-10-27T02:00:00Z" }, cursor: "c" },
      { snapshot: { ...snapshot("previous-good", "available", NAME), requestedAt: "2026-10-27T01:00:00Z" }, cursor: "d" },
    ];

    await pruneSnapshots(client(undefined, api), built, NAME, 2);

    expect(fake.inputs("snapshot.delete")).toEqual([
      { sandboxGroupId: "sbg-1", snapshotId: "recent-failure" },
      { sandboxGroupId: "sbg-1", snapshotId: "older-failure" },
    ]);
  });

  it("keeps the newest two available snapshots of this name, across list pages, and leaves other names alone", async () => {
    const api = fake.api();
    const queries: unknown[] = [];
    const at = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();
    const others = Array.from({ length: 100 }, (_, i) => ({ snapshot: snapshot(`snp-other-${i}`, "available", "someone-else"), cursor: `o${i}` }));
    api.snapshots.list = async (input) => {
      queries.push(input);
      if (!input.cursor) return others;
      return [
        { snapshot: { ...snapshot("snp-3", "available", NAME), requestedAt: at(1000) }, cursor: "a" },
        { snapshot: { ...snapshot("snp-1", "failed", NAME), requestedAt: at(3000) }, cursor: "b" },
        { snapshot: { ...snapshot("snp-2", "available", NAME), requestedAt: at(2000) }, cursor: "c" },
      ];
    };
    await pruneSnapshots(client(undefined, api), built, NAME, 2);
    expect(fake.inputs("snapshot.delete")).toEqual([{ sandboxGroupId: "sbg-1", snapshotId: "snp-1" }]);
    expect(queries).toEqual([
      { sandboxGroupId: "sbg-1", status: ["available", "failed"], cursor: undefined, limit: 100 },
      { sandboxGroupId: "sbg-1", status: ["available", "failed"], cursor: "o99", limit: 100 },
    ]);
  });

  const entry = (id: string, status: "available" | "failed" | "creating", rank: number, name = NAME, group = "sbg-1") => ({
    snapshot: { ...snapshot(id, status, name), sandboxGroupId: group, requestedAt: new Date(1_700_000_000_000 + rank * 1000).toISOString() },
    cursor: id,
  });

  it.each([
    { name: "has no snapshots", rows: [], keep: 2, deleted: [] },
    { name: "has fewer successful snapshots than keep", rows: [entry("only-good", "available", 1), entry("failure", "failed", 2)], keep: 2, deleted: ["failure"] },
    { name: "has no failed captures", rows: [entry("oldest", "available", 1), entry("newest", "available", 4), entry("prior", "available", 3), entry("older", "available", 2)], keep: 2, deleted: ["older", "oldest"] },
    { name: "mixes stale successes and multiple recent failures", rows: [entry("oldest", "available", 1), entry("failed-1", "failed", 5), entry("prior", "available", 3), entry("failed-2", "failed", 6), entry("newest", "available", 4), entry("older", "available", 2)], keep: 2, deleted: ["failed-1", "failed-2", "older", "oldest"] },
    { name: "requests zero retained successes", rows: [entry("good", "available", 1), entry("failure", "failed", 2)], keep: 0, deleted: ["failure", "good"] },
  ])("prunes only eligible entries when the history $name", async ({ rows, keep, deleted }) => {
    const api = fake.api();
    api.snapshots.list = async () => rows;

    await pruneSnapshots(client(undefined, api), built, NAME, keep);

    const ids = fake.inputs("snapshot.delete").map((input) => (input as { snapshotId: string }).snapshotId).sort();
    expect(ids).toEqual(deleted);
  });

  it("never deletes creating snapshots or snapshots from other names or groups", async () => {
    const api = fake.api();
    api.snapshots.list = async () => [
      entry("building", "creating", 1),
      entry("other-name", "failed", 2, "another-corpus"),
      entry("other-group-available", "available", 3, NAME, "sbg-other"),
      entry("other-group-failed", "failed", 4, NAME, "sbg-other"),
      entry("eligible", "failed", 5),
    ];

    await pruneSnapshots(client(undefined, api), built, NAME, 0);

    expect(fake.inputs("snapshot.delete")).toEqual([{ sandboxGroupId: "sbg-1", snapshotId: "eligible" }]);
  });

  it("continues pruning when a snapshot is already missing", async () => {
    const api = fake.api();
    api.snapshots.list = async () => [entry("typed-missing", "failed", 1), entry("generic-missing", "failed", 2), entry("present", "failed", 3)];
    const remove = api.snapshots.delete;
    api.snapshots.delete = async (input) => {
      await remove(input);
      if (input.snapshotId === "typed-missing") throw new SandboxSnapshotNotFoundError("already missing", 404);
      if (input.snapshotId === "generic-missing") throw new ClientError("already missing", 404);
    };

    await expect(pruneSnapshots(client(undefined, api), built, NAME, 2)).resolves.toBeUndefined();

    expect(fake.inputs("snapshot.delete")).toHaveLength(3);
    expect(logs).toEqual([]);
  });

  it("warns without failing a successful build when snapshot deletion fails", async () => {
    const api = fake.api();
    api.snapshots.list = async () => [entry("failure", "failed", 1)];
    const failure = new Error("synthetic delete failure");
    api.snapshots.delete = async () => { throw failure; };

    await expect(pruneSnapshots(client(undefined, api), built, NAME, 2)).resolves.toBeUndefined();

    expect(logs).toEqual([expect.objectContaining({ level: "warn", snapshot_name: NAME, err: expect.objectContaining({ message: failure.message }) })]);
  });

  it("logs a failed prune instead of throwing, so a good build still succeeds", async () => {
    const api = fake.api();
    api.snapshots.list = async () => {
      throw new Error("list exploded");
    };
    await expect(pruneSnapshots(client(undefined, api), built, NAME, 2)).resolves.toBeUndefined();
    expect(logs).toEqual([expect.objectContaining({ level: "warn", snapshot_name: NAME })]);
  });
});

describe("openRenderSandbox", () => {
  it("creates a sandbox by snapshot name with the configured policy and verifies its egress", async () => {
    fake.exec_ = prepareExec;
    const sbx = await openRenderSandbox(client(), NAME, OPEN);

    expect(sbx).toMatchObject(LAYOUT);
    expect(sbx.manifest.repos).toEqual(fake.manifest().repos);
    expect(sbx.info).toMatchObject({ runnerNonDumpable: true, piVersion: "0.83.0", promptVersion: "v3" });
    expect(fake.inputs("create")).toEqual([{
      snapshotName: NAME,
      timeoutSeconds: 1_800,
      networkPolicy: { type: "allow-list", rules: [{ domain: "api.anthropic.com", protocol: "https" }] },
    }]);
    const verify = fake.commands().filter((c) => c.includes("verify.sh"));
    expect(verify).toHaveLength(1);
    expect(verify[0]).toContain("--deny-probe https://example.com");
    expect(verify[0]).toContain("--allow-probe 'https://api.anthropic.com'");
  });

  it.each([
    { name: "no snapshot has that name", error: new SandboxSnapshotNotFoundError("snapshot not found", 404), notReady: false },
    { name: "the snapshot isn't available yet", error: new SandboxSnapshotNotReadyError("snapshot not ready", 409), notReady: true },
  ])("throws SnapshotUnavailableError when $name", async ({ error, notReady }) => {
    fake.createError = () => error;
    const err = await openRenderSandbox(client(), NAME, OPEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotUnavailableError);
    expect(err).toMatchObject({ notReady });
  });

  it("throws SandboxMisconfiguredError when Render rejects the allow-list, so it isn't retried", async () => {
    fake.createError = () => new ClientError("invalid networkPolicy", 422);
    await expect(openRenderSandbox(client(), NAME, OPEN)).rejects.toBeInstanceOf(SandboxMisconfiguredError);
  });

  it("refuses and terminates a sandbox where verify.sh couldn't confirm the runner is non-dumpable", async () => {
    fake.exec_ = dumpableExec;
    await expect(openRenderSandbox(client(), NAME, OPEN)).rejects.toThrow("non-dumpable");
    expect(fake.terminated()).toEqual(["sbx-1"]);
  });

  it("refuses and terminates a sandbox created with wider egress than requested", async () => {
    fake.exec_ = prepareExec;
    fake.createdPolicy = { type: "allow-all" };
    await expect(openRenderSandbox(client(), NAME, OPEN)).rejects.toThrow("refusing unexpected egress");
    expect(fake.terminated()).toEqual(["sbx-1"]);
    expect(fake.commands()).toEqual([]);
  });

  it("refuses and terminates a sandbox created with different allow-list rules", async () => {
    fake.exec_ = prepareExec;
    fake.createdPolicy = {
      type: "allow-list",
      rules: [{ domain: "*.example.com", protocol: "https" }],
    };
    await expect(openRenderSandbox(client(), NAME, OPEN)).rejects.toThrow("refusing unexpected egress");
    expect(fake.terminated()).toEqual(["sbx-1"]);
    expect(fake.commands()).toEqual([]);
  });

  it("gives up within timeoutMs and terminates the sandbox", async () => {
    fake.exec_ = (id, command, signal) =>
      command.includes("verify.sh")
        ? (async function* () {
            await new Promise((resolve) => signal!.addEventListener("abort", resolve));
            throw new AbortError();
          })()
        : prepareExec(id, command);
    const started = Date.now();
    await expect(openRenderSandbox(client(), NAME, { timeoutMs: 100 })).rejects.toThrow("within 100ms");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fake.terminated()).toEqual(["sbx-1"]);
  });
});

const event = (e: object) => `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`;
const clarify = event({ type: "result", result: { status: "needs_clarification", question: "Which region?", why_needed: "x" } });
const runsInvestigation = (events: () => SandboxExecEvent[] | AsyncGenerator<SandboxExecEvent>): ExecHandler =>
  (_id, command) => (command.includes("run-investigation.sh") ? events() : [exit(0)]);

describe("runInvestigation", () => {
  it("recovers required output after a transport failure without rerunning the investigation", async () => {
    fake.exec_ = runsInvestigation(() => [exit(0)]);
    let downloads = 0;
    fake.file_ = (path) => {
      if (!path.endsWith(".jsonl")) return undefined;
      if (++downloads === 1) throw new TypeError("synthetic output transport failure");
      return clarify;
    };

    const res = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), modelApiKey: MODEL_KEY, timeoutMs: 60_000 });

    expect(res.events).toEqual([JSON.parse(clarify)]);
    expect(classifyRun(res, captureRun(res.events), { elapsedMs: 1, agentTimeoutMs: 60_000 }).kind).toBe("result");
    expect(downloads).toBe(2);
    expect(fake.commands().filter((command) => command.includes("run-investigation.sh"))).toHaveLength(1);
    expect(fake.calls.filter((call) => call.op === "upload" && call.path.endsWith("/key"))).toHaveLength(1);
  });

  it("throws an infrastructure error with the last transport cause after three output requests", async () => {
    fake.exec_ = runsInvestigation(() => [exit(0)]);
    const failures = [1, 2, 3].map((attempt) => new TypeError(`synthetic output failure ${attempt}`));
    let downloads = 0;
    fake.file_ = (path) => {
      if (!path.endsWith(".jsonl")) return undefined;
      throw failures[downloads++];
    };

    const error = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), timeoutMs: 60_000 }).catch((err: unknown) => err);

    expect(error).toMatchObject({ message: expect.stringContaining("after 3 attempt(s)"), cause: failures[2] });
    expect(downloads).toBe(3);
    expect(fake.commands().filter((command) => command.includes("run-investigation.sh"))).toHaveLength(1);
  });

  it("keeps a genuinely downloaded empty output as an agent failure, without transport retries", async () => {
    fake.exec_ = runsInvestigation(() => [exit(0)]);
    let downloads = 0;
    fake.file_ = (path) => path.endsWith(".jsonl") ? (downloads++, "") : undefined;

    const res = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), timeoutMs: 60_000 });

    expect(res).toMatchObject({ exitCode: 0, aborted: false, events: [], invalidLines: 0 });
    expect(classifyRun(res, captureRun(res.events), { elapsedMs: 1, agentTimeoutMs: 60_000 })).toMatchObject({ kind: "failed", code: "agent_error" });
    expect(downloads).toBe(1);
  });

  it("keeps an aborted run's output best-effort", async () => {
    const controller = new AbortController();
    fake.exec_ = runsInvestigation(async function* () {
      controller.abort();
      throw new AbortError();
    });

    const res = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), timeoutMs: 60_000, signal: controller.signal });

    expect(res).toMatchObject({ exitCode: null, aborted: true, events: [] });
    expect(classifyRun(res, captureRun(res.events), { elapsedMs: 1, agentTimeoutMs: 60_000 })).toMatchObject({ kind: "failed", code: "timeout" });
  });

  it("recovers a complete result even after an explicit abort", async () => {
    const controller = new AbortController();
    fake.exec_ = runsInvestigation(async function* () {
      controller.abort();
      throw new AbortError();
    });
    fake.file_ = (path) => path.endsWith(".jsonl") ? clarify : undefined;

    const res = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), timeoutMs: 60_000, signal: controller.signal });

    expect(res.aborted).toBe(true);
    expect(classifyRun(res, captureRun(res.events), { elapsedMs: 1, agentTimeoutMs: 60_000 }).kind).toBe("result");
  });

  it("returns the run's events and exit status, streaming stderr and counting invalid lines", async () => {
    const started = event({ type: "started", pi_version: "0.83.0", model: "m", prompt_version: "v3" });
    fake.exec_ = runsInvestigation(() => [out("runner ", "stderr"), out("diagnostics", "stderr"), exit(0)]);
    fake.file_ = (path) => (path.endsWith(".jsonl") ? started + "not json\n" + '{"type":"nope"}\n' + clarify : undefined);
    const stderr: string[] = [];

    const res = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), timeoutMs: 60_000, onStderr: (c) => void stderr.push(c) });

    expect(res).toMatchObject({ exitCode: 0, aborted: false, streamLost: false, invalidLines: 2, stderrTail: "runner diagnostics" });
    expect(res.events.map((e) => e.type)).toEqual(["started", "result"]);
    expect(stderr).toEqual(["runner ", "diagnostics"]);
  });

  it("uploads the model key as a file beside the input and never puts it in a command", async () => {
    fake.file_ = (path) => path.endsWith(".jsonl") ? "" : undefined;
    await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), modelApiKey: MODEL_KEY, timeoutMs: 90_000 });

    expect(fake.commands().some((c) => c.includes(MODEL_KEY))).toBe(false);
    const run = fake.commands().find((c) => c.includes("run-investigation.sh"))!;
    const runDir = / (\/tmp\/run-\S+) 90$/.exec(run)?.[1];
    expect(runDir).toBeDefined();
    expect(fake.calls).toContainEqual({ op: "upload", id: "sbx-run", path: `${runDir}/key`, data: MODEL_KEY });
  });

  it("recovers the exit status from the exit file after the exec stream drops", async () => {
    fake.exec_ = runsInvestigation(async function* () {
      yield out("partial diagnostics", "stderr");
      throw new RenderError("Sandbox exec stream ended without a terminal event.");
    });
    let polls = 0;
    fake.file_ = (path) => (path.endsWith(".exit") ? (++polls < 3 ? undefined : "0\n") : path.endsWith(".jsonl") ? clarify : undefined);

    const res = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), timeoutMs: 60_000 });

    expect(res).toMatchObject({ exitCode: 0, aborted: false, streamLost: false, stderrTail: "partial diagnostics" });
    expect(res.events.map((e) => e.type)).toEqual(["result"]);
  });

  it("reports the run as lost when the sandbox stops after the exec stream drops", async () => {
    fake.exec_ = runsInvestigation(async function* () {
      throw new RenderError("Sandbox exec stream ended without a terminal event.");
    });
    fake.status = "terminated";
    const res = await runInvestigation(client(), "sbx-run", { input: runnerInput(LAYOUT), timeoutMs: 60_000 });
    expect(res).toMatchObject({ exitCode: null, aborted: false, streamLost: true });
  });
});

describe("SandboxClient.terminate", () => {
  it("gives up after its cleanup budget when the terminate request hangs", async () => {
    const api = fake.api();
    api.terminate = () => new Promise(() => {});
    const original = client(undefined, api);
    const bounded = new SandboxClient(api, original.cfg, original.log, { ...original.t, cleanupTimeoutMs: 20 });
    const started = Date.now();

    await expect(bounded.terminate("sbx-hung")).rejects.toThrow("did not finish within 20ms");
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(bounded.terminateQuietly("sbx-hung")).resolves.toBeUndefined();
  });
});

describe("configureSandboxes", () => {
  it("maps comma-separated domains and wildcards to HTTPS egress rules", async () => {
    const cfg = await loadRenderConfig({
      RENDER_API_KEY: "rnd_test",
      RENDER_WORKSPACE_ID: "tea-test",
      SANDBOX_ALLOWED_DOMAINS: "API.GITHUB.COM, *.pypi.org, api.github.com",
    });
    expect(cfg.networkPolicy).toEqual({
      type: "allow-list",
      rules: [
        { domain: "api.github.com", protocol: "https" },
        { domain: "*.pypi.org", protocol: "https" },
      ],
    });
  });

  it("requires Render sandboxes on Render, defaults to local elsewhere, and rejects unknown providers", async () => {
    await expect(configureSandboxes({ RENDER: "true" }, silent)).rejects.toThrow("RENDER_API_KEY");
    await expect(configureSandboxes({}, silent)).resolves.toBeTypeOf("function");
    await expect(configureSandboxes({ SANDBOX_PROVIDER: "nope" }, silent)).rejects.toThrow("SANDBOX_PROVIDER");
  });
});
