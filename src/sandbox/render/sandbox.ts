import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, SandboxSnapshotNotFoundError, SandboxSnapshotNotReadyError } from "@renderinc/sdk";
import { z } from "zod";
import { RepoManifest } from "../../manifest.ts";
import { errorMessage } from "../../util.ts";
import {
  SandboxMisconfiguredError,
  SnapshotUnavailableError,
  appendStderrTail,
  parseRunnerEvents,
  shq,
  type OpenSandboxOptions,
  type RunInvestigationOptions,
  type RunInvestigationResult,
  type Sandbox,
} from "../interface.ts";
import { TRANSIENT, type SandboxApi, type SandboxClient } from "./client.ts";
import type { NetworkPolicy } from "./config.ts";

/** Fixed paths inside every sandbox. The snapshot build creates them; restored sandboxes find them in place. */
export const SANDBOX_ROOT = "/opt/researcher";
export const SANDBOX_APP = `${SANDBOX_ROOT}/app`;
export const SANDBOX_REPOS = `${SANDBOX_ROOT}/repos`;
export const SANDBOX_SCRATCH = `${SANDBOX_ROOT}/scratch`;
export const SANDBOX_RUN_AS = "investigator";

/** Must be unreachable under deny-all / allow-list; checked from inside each restored sandbox. */
const DENY_PROBE_URL = "https://example.com";

const SandboxInfo = z.object({
  runAs: z.string().min(1),
  uid: z.number().int(),
  drop: z.string(),
  node: z.string(),
  runnerNonDumpable: z.boolean(),
  dnsResolves: z.boolean(),
  selfTest: z.looseObject({ ok: z.literal(true), pi_version: z.string(), prompt_version: z.string() }),
});
type SandboxInfo = z.infer<typeof SandboxInfo>;

/** Runs verify.sh, which fails unless the sandbox is locked down, and parses the JSON line it prints last. */
export async function verifySandbox(
  client: SandboxClient,
  id: string,
  opts: { probes?: NetworkPolicy; waitReady?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SandboxInfo> {
  const command = `bash ${SANDBOX_APP}/verify.sh${opts.probes ? probeArgs(opts.probes) : ""}`;
  const res = await client.exec(id, command, {
    timeoutMs: opts.timeoutMs ?? client.t.verifyTimeoutMs,
    waitReady: opts.waitReady,
    signal: opts.signal,
  });
  if (res.exitCode !== 0) throw new Error(`verify.sh exited ${res.exitCode}: ${res.stderr.trim().slice(-2000)}`);
  const last = res.stdout.trim().split("\n").at(-1) ?? "";
  try {
    return SandboxInfo.parse(JSON.parse(last));
  } catch (err) {
    throw new Error(`unexpected sandbox info line ${JSON.stringify(last.slice(0, 300))}: ${errorMessage(err)}`);
  }
}

function probeArgs(policy: NetworkPolicy): string {
  if (policy.type === "allow-all") return "";
  const allowed = policy.type === "allow-list" ? policy.rules.find((r) => !r.domain.startsWith("*."))?.domain : undefined;
  return ` --deny-probe ${DENY_PROBE_URL}${allowed ? ` --allow-probe ${shq(`https://${allowed}`)}` : ""}`;
}

type EgressPolicy = {
  type: string;
  rules?: Array<{ domain: string; protocol?: string }>;
};

function policyRules(policy: EgressPolicy): string[] {
  return policy.type === "allow-list"
    ? (policy.rules ?? []).map((r) => `${(r.protocol ?? "https").toLowerCase()}://${r.domain.toLowerCase()}`).sort()
    : [];
}

function policiesMatch(actual: EgressPolicy, requested: EgressPolicy): boolean {
  return actual.type === requested.type
    && JSON.stringify(policyRules(actual)) === JSON.stringify(policyRules(requested));
}

/**
 * Creates a sandbox from the newest available snapshot with `snapshotName`, under the configured
 * network policy and a provider-side timeout backstop, then verifies it (including egress probes)
 * and reads its manifest, all within `timeoutMs`. Terminates the sandbox if anything after creation fails.
 */
export async function openRenderSandbox(client: SandboxClient, snapshotName: string, { timeoutMs }: OpenSandboxOptions): Promise<Sandbox> {
  const policy = client.cfg.networkPolicy;
  if (policy.type === "allow-list" && !policy.rules.length) {
    throw new Error("cannot create an investigation sandbox with allow-list policy and no egress rules");
  }
  // SDK create and get take no signal: one of those requests in flight can finish past the deadline.
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = (cause: unknown) =>
    new Error(`could not open a sandbox from ${JSON.stringify(snapshotName)} within ${timeoutMs}ms (SANDBOX_PROVISION_TIMEOUT_MS)`, { cause });
  let created: Awaited<ReturnType<SandboxApi["create"]>>;
  try {
    created = await client.call(
      () => client.api.create({ snapshotName, networkPolicy: policy, timeoutSeconds: client.cfg.investigationTimeoutSeconds }),
      { signal },
    );
  } catch (err) {
    if (err instanceof SandboxSnapshotNotFoundError || err instanceof SandboxSnapshotNotReadyError) {
      throw new SnapshotUnavailableError(`no available snapshot named ${JSON.stringify(snapshotName)}: ${err.message}`, {
        cause: err,
        notReady: err instanceof SandboxSnapshotNotReadyError,
      });
    }
    if (signal.aborted) throw timedOut(err);
    if (policy.type === "allow-list" && err instanceof ClientError && [400, 422].includes(err.statusCode)) {
      throw new SandboxMisconfiguredError(
        `Render rejected HTTPS egress allow-list [${policyRules(policy).join(", ")}]: ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }
  const { id } = created;
  try {
    if (!policiesMatch(created.networkPolicy, policy)) {
      throw new Error(
        `Render created ${id} with networkPolicy ${created.networkPolicy.type} [${policyRules(created.networkPolicy).join(", ")}], ` +
          `not ${policy.type} [${policyRules(policy).join(", ")}]; refusing unexpected egress`,
      );
    }
    await client.waitRunning(id, { timeoutMs, signal });
    const info = await verifySandbox(client, id, { probes: policy, waitReady: true, timeoutMs, signal });
    // verify.sh can only probe /proc as root; a sandbox where it couldn't check doesn't get the model key.
    if (!info.runnerNonDumpable) throw new Error(`could not confirm the runner is non-dumpable in ${id}; refusing to run an investigation`);
    const manifest = RepoManifest.parse(JSON.parse(await client.download(id, `${SANDBOX_APP}/manifest.json`, signal)));
    return {
      id,
      manifest,
      reposRoot: SANDBOX_REPOS,
      scratchDir: SANDBOX_SCRATCH,
      info: {
        runAs: info.runAs,
        uid: info.uid,
        privilegeDrop: info.drop,
        node: info.node,
        runnerNonDumpable: info.runnerNonDumpable,
        dnsResolves: info.dnsResolves,
        piVersion: info.selfTest.pi_version,
        promptVersion: info.selfTest.prompt_version,
      },
      run: (opts) => runInvestigation(client, id, opts),
      close: () => client.terminate(id),
    };
  } catch (err) {
    await client.terminateQuietly(id);
    throw signal.aborted ? timedOut(err) : err;
  }
}

export async function runInvestigation(client: SandboxClient, id: string, opts: RunInvestigationOptions): Promise<RunInvestigationResult> {
  const runDir = `/tmp/run-${randomUUID()}`;
  const deadline = AbortSignal.timeout(opts.timeoutMs + client.t.investigationGraceMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let exitCode: number | null = null;
  let stderrTail = "";
  let streaming = false;
  try {
    await client.check(id, `mkdir -p -m 700 ${runDir}`, { timeoutMs: client.t.verifyTimeoutMs, signal });
    await client.upload(id, `${runDir}/input.json`, JSON.stringify(opts.input), { signal });
    if (opts.modelApiKey) await client.upload(id, `${runDir}/key`, opts.modelApiKey, { signal });
    const command = `bash ${SANDBOX_APP}/run-investigation.sh ${runDir} ${Math.ceil(opts.timeoutMs / 1000)}`;
    const stream = await client.call(() => client.api.exec(id, command, undefined, signal), { retryOn: TRANSIENT, signal });
    streaming = true;
    for await (const ev of stream) {
      if (ev.type === "exit") {
        exitCode = ev.exit_code;
        break;
      }
      stderrTail = appendStderrTail(stderrTail, ev.data);
      opts.onStderr?.(ev.data);
    }
  } catch (err) {
    if (!streaming && !signal.aborted) throw err;
  }
  // A dropped exec stream doesn't stop the run, and the API can't reattach to it, so wait for the exit
  // status run-investigation.sh writes to a file instead.
  if (exitCode === null && !signal.aborted) exitCode = await awaitExitFile(client, id, runDir, signal);
  const output = await readRunFile(client, id, `${runDir}.jsonl`, AbortSignal.timeout(client.t.verifyTimeoutMs));
  return {
    exitCode,
    aborted: exitCode === null && signal.aborted,
    streamLost: exitCode === null && !signal.aborted,
    stderrTail,
    ...parseRunnerEvents(output ?? ""),
  };
}

/** Polls for the run's exit status until it appears, the sandbox stops running, or `signal` fires. */
async function awaitExitFile(client: SandboxClient, id: string, runDir: string, signal: AbortSignal): Promise<number | null> {
  while (!signal.aborted) {
    const status = (await readRunFile(client, id, `${runDir}.exit`, signal))?.trim();
    if (status && /^\d+$/.test(status)) return Number(status);
    const sbx = await client.call(() => client.api.get(id), { retryOn: TRANSIENT, signal }).catch(() => null);
    if (sbx?.status !== "running") return null;
    await sleep(client.t.pollMs, undefined, { signal }).catch(() => {});
  }
  return null;
}

/** Null when the file can't be read: not written yet, or the sandbox is gone. */
async function readRunFile(client: SandboxClient, id: string, path: string, signal: AbortSignal): Promise<string | null> {
  return client.download(id, path, signal).catch(() => null);
}
