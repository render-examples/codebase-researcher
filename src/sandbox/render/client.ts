import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, ServerError } from "@renderinc/sdk";
import type { SandboxesClient, SandboxExecEvent, SandboxUploadContentType } from "@renderinc/sdk/experimental";
import type { Log } from "../../log.ts";
import type { RenderConfig } from "./config.ts";
import { abortable, createSandboxApi, deadline, REQUEST_TIMEOUT_MS, withSandboxSignal } from "./transport.ts";

/** The subset of the SDK's SandboxesClient used here; tests substitute a fake. */
export type SandboxApi = Pick<SandboxesClient, "create" | "get" | "exec" | "upload" | "download" | "terminate"> & {
  snapshots: Pick<SandboxesClient["snapshots"], "create" | "get" | "list" | "delete">;
};

export type RenderTimings = {
  /** Minimum gap between get()/snapshot polls (rate limit: 100 req/min per workspace). */
  pollMs: number;
  /** Default call budget (pacing/retries included) and individual control-request backstop. */
  requestTimeoutMs: number;
  /** Independent termination budget, including pacing, retries, HTTP and response-body reads. */
  cleanupTimeoutMs: number;
  bootTimeoutMs: number;
  prepareTimeoutMs: number;
  snapshotTimeoutMs: number;
  verifyTimeoutMs: number;
  /** Client-side abort lands this long after the in-sandbox `timeout`, which should fire first. */
  investigationGraceMs: number;
};

const DEFAULT_TIMINGS: RenderTimings = {
  pollMs: 3_000,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  cleanupTimeoutMs: 10_000,
  bootTimeoutMs: 5 * 60_000,
  prepareTimeoutMs: 60 * 60_000,
  snapshotTimeoutMs: 20 * 60_000,
  verifyTimeoutMs: 5 * 60_000,
  investigationGraceMs: 30_000,
};

const OUTPUT_TAIL = 64 * 1024;
export const TRANSIENT = [429, 503];
/**
 * A just-created sandbox can answer 404 to `get` and to `exec` for a short while (and `exec` can fail
 * briefly after it reports `running`), so readiness checks treat 404 as "not yet".
 */
const READY_RETRY = [404, ...TRANSIENT];

type ExecOptions = { timeoutMs: number; waitReady?: boolean; signal?: AbortSignal };

/**
 * The SDK's experimental sandbox client plus what it leaves to callers:
 * - pacing: the Sandbox API allows 100 requests/min per workspace and the SDK neither paces nor retries 429s;
 * - retries on 429/503, which the SDK surfaces as errors;
 * - `waitRunning`: `create` returns while the sandbox is still `creating`, and there is no wait helper;
 * - `exec` collection: the SDK returns decoded stream events; `exec` here gathers output and the exit code.
 * Drop each piece when the SDK grows the equivalent.
 */
export class SandboxClient {
  readonly t: RenderTimings;
  #nextRequestAt = 0;

  constructor(
    readonly api: SandboxApi,
    readonly cfg: RenderConfig,
    readonly log: Log,
    timings: Partial<RenderTimings> = {},
  ) {
    this.t = { ...DEFAULT_TIMINGS, ...timings };
  }

  static fromConfig(cfg: RenderConfig, log: Log, timings: Partial<RenderTimings> = {}): SandboxClient {
    const t = { ...DEFAULT_TIMINGS, ...timings };
    return new SandboxClient(createSandboxApi(cfg, t.requestTimeoutMs), cfg, log, t);
  }

  /** Paces every API call and retries the given statuses (429 by default, which is never processed server-side). */
  async call<T>(fn: () => Promise<T>, opts: { retryOn?: readonly number[]; attempts?: number; signal?: AbortSignal; timeoutMs?: number; onLateResult?: (value: T) => Promise<void> } = {}): Promise<T> {
    const signal = deadline(opts.signal, opts.timeoutMs ?? this.t.requestTimeoutMs);
    signal.throwIfAborted();
    const retryOn = opts.retryOn ?? [429];
    const attempts = opts.attempts ?? 5;
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      const now = Date.now();
      const at = Math.max(now, this.#nextRequestAt);
      this.#nextRequestAt = at + this.cfg.minRequestIntervalMs;
      if (at > now) await sleep(at - now, undefined, { signal });
      signal.throwIfAborted();
      try {
        return await abortable(withSandboxSignal(signal, fn), signal, opts.onLateResult);
      } catch (err) {
        const status = err instanceof ClientError || err instanceof ServerError ? err.statusCode : undefined;
        if (attempt >= attempts || status === undefined || !retryOn.includes(status) || signal.aborted) throw err;
        await sleep(this.t.pollMs, undefined, { signal });
      }
    }
  }

  /** Never retry an uncertain create. A late returned ID still gets independent cleanup. */
  async create(input: Parameters<SandboxApi["create"]>[0], opts: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    let requested = false;
    try {
      return await this.call(() => {
        requested = true;
        return this.api.create({ ...input, timeoutSeconds: input?.timeoutSeconds ?? this.cfg.investigationTimeoutSeconds }).catch((err: unknown) => {
          if (err instanceof ClientError) requested = false; // A rejected request created no resource.
          throw err;
        });
      }, { ...opts, onLateResult: ({ id }) => this.terminateQuietly(id) });
    } catch (err) {
      if (requested && !(err instanceof ClientError)) {
        this.log.warn("sandbox create outcome unknown; provider lifetime timeout remains the backstop", { event: "sandbox_create_unknown" });
      }
      throw err;
    }
  }

  async exec(id: string, command: string, opts: ExecOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const retry = opts.waitReady
      ? { retryOn: READY_RETRY, attempts: Math.ceil(opts.timeoutMs / Math.max(this.t.pollMs, 1)) }
      : { retryOn: TRANSIENT };
    let stdout = "";
    let stderr = "";
    try {
      const stream = await this.call(() => this.api.exec(id, command, undefined, signal), { ...retry, signal });
      for await (const ev of this.events(stream, signal)) {
        if (ev.type === "exit") return { exitCode: ev.exit_code, stdout, stderr };
        if (ev.stream === "stdout") stdout = (stdout + ev.data).slice(-OUTPUT_TAIL);
        else stderr = (stderr + ev.data).slice(-OUTPUT_TAIL);
      }
    } catch (err) {
      if (timeout.aborted) throw new Error(`exec in ${id} timed out after ${opts.timeoutMs}ms: ${command}`);
      throw err;
    }
    throw new Error(`exec in ${id} ended without an exit event: ${command}`);
  }

  async *events(stream: AsyncGenerator<SandboxExecEvent>, signal: AbortSignal) {
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = await abortable(stream.next(), signal);
        if (next.done) return;
        yield next.value;
      }
    } finally {
      void stream.return(undefined).catch(() => {});
    }
  }

  /** Like `exec`, but throws on a non-zero exit. */
  async check(id: string, command: string, opts: ExecOptions): Promise<void> {
    const res = await this.exec(id, command, opts);
    if (res.exitCode !== 0) throw new Error(`${command} exited ${res.exitCode} in ${id}: ${res.stderr.trim().slice(-1000)}`);
  }

  async upload(
    id: string,
    path: string,
    data: string | Buffer,
    opts: { contentType?: SandboxUploadContentType; signal?: AbortSignal } = {},
  ): Promise<void> {
    const signal = deadline(opts.signal, this.t.requestTimeoutMs);
    await this.call(() => this.api.upload(id, path, data, undefined, { ...opts, signal }), { retryOn: TRANSIENT, signal });
  }

  async download(id: string, path: string, signal?: AbortSignal): Promise<string> {
    signal = deadline(signal, this.t.requestTimeoutMs);
    const file = await this.call(() => this.api.download(id, path, undefined, signal), { retryOn: TRANSIENT, signal });
    return file.data.toString("utf8");
  }

  async waitRunning(id: string, { timeoutMs = this.t.bootTimeoutMs, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const until = Date.now() + timeoutMs;
    signal = deadline(signal, timeoutMs);
    for (;;) {
      const { status } = await this.call(() => this.api.get(id), { retryOn: READY_RETRY, signal });
      if (status === "running") return;
      if (status === "errored" || status === "terminated") throw new Error(`sandbox ${id} is ${status}`);
      if (Date.now() > until) throw new Error(`sandbox ${id} still ${status} after ${timeoutMs}ms`);
      await sleep(this.t.pollMs, undefined, { signal });
    }
  }

  /** Idempotent: a sandbox that no longer exists counts as terminated. */
  async terminate(id: string): Promise<void> {
    try {
      await this.call(() => this.api.terminate(id), { retryOn: TRANSIENT, timeoutMs: this.t.cleanupTimeoutMs });
    } catch (err) {
      if (err instanceof ClientError && err.statusCode === 404) return;
      throw err;
    }
  }

  async terminateQuietly(id: string): Promise<void> {
    await this.terminate(id).catch((err: unknown) => this.log.warn("could not terminate sandbox", { sandbox_id: id, err }));
  }
}
