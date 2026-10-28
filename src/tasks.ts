import { z } from "zod";
import { AnswerQuestionInput, type Callback, type Reply } from "./question.ts";
import {
  buildEvidenceUrl,
  MESSAGE_MAX_CHARS,
  TRANSCRIPT_MAX_MESSAGES,
  type Evidence,
  type InvestigationResult,
  type Transcript,
} from "./investigation.ts";
import type { RepoManifest } from "./manifest.ts";
import { RUNNER_EXIT, RunnerInput, type RunnerEvent, type Usage } from "./runner/protocol.ts";
import { SandboxMisconfiguredError, SnapshotUnavailableError, type OpenSandbox, type RunInvestigationResult, type Sandbox } from "./sandbox/index.ts";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { signCallback } from "./callback.ts";
import type { Log } from "./log.ts";
import type { Config } from "./workflow.ts";

export type RunnerErrorCode = Extract<RunnerEvent, { type: "error" }>["code"];

export type RunCapture = {
  started?: Extract<RunnerEvent, { type: "started" }>;
  result?: { value: InvestigationResult; at: string };
  error?: { code: RunnerErrorCode; message: string };
  usage?: Usage;
};

/** Folds the runner's event stream into what the workflow records. */
export function captureRun(events: RunnerEvent[]): RunCapture {
  const capture: RunCapture = {};
  for (const event of events) {
    switch (event.type) {
      case "started":
        capture.started ??= event;
        break;
      case "usage":
        capture.usage = addUsage(capture.usage, event.usage);
        break;
      case "result":
        capture.result = { value: event.result, at: event.at };
        break;
      case "error":
        capture.error ??= { code: event.code, message: event.message };
        break;
    }
  }
  return capture;
}

const TOKEN_KEYS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;

function addUsage(total: Usage | undefined, next: Usage): Usage {
  const sum: Usage = { ...next };
  for (const key of TOKEN_KEYS) sum[key] = (total?.[key] ?? 0) + next[key];
  if (total?.cost_usd !== undefined || next.cost_usd !== undefined) {
    sum.cost_usd = (total?.cost_usd ?? 0) + (next.cost_usd ?? 0);
  }
  return sum;
}

export type FailureCode = RunnerErrorCode | "retries_exhausted" | "misconfigured" | "no_snapshot" | "snapshot_not_ready" | "invalid_question";

const EXIT_TIMEOUT = 124; // coreutils `timeout`
const EXIT_SIGKILL = 137;

export type RunVerdict =
  | { kind: "result"; value: InvestigationResult; at: string }
  | { kind: "failed"; code: FailureCode; message: string };

/** Throws when the sandbox, not the agent, failed, so the workflow retries. */
export function classifyRun(
  run: RunInvestigationResult,
  capture: RunCapture,
  { elapsedMs, agentTimeoutMs }: { elapsedMs: number; agentTimeoutMs: number },
): RunVerdict {
  if (capture.result) return { kind: "result", ...capture.result };
  if (capture.error) return { kind: "failed", ...capture.error };

  const exit = run.exitCode;
  const timedOut =
    run.aborted ||
    exit === EXIT_TIMEOUT ||
    exit === RUNNER_EXIT.timeout ||
    (exit === EXIT_SIGKILL && elapsedMs >= agentTimeoutMs);
  if (timedOut) return { kind: "failed", code: "timeout", message: `runner killed after ${agentTimeoutMs}ms` };

  const stderr = run.stderrTail && `: ${run.stderrTail}`;
  if (exit !== null && exit < 128) {
    return { kind: "failed", code: "agent_error", message: `runner exited (${exit}) without a result${stderr}` };
  }
  const why =
    exit === null ? "lost the runner's exec stream before it exited"
    : exit === EXIT_SIGKILL ? `runner was killed after ${elapsedMs}ms (out of memory or killed by the sandbox)`
    : `runner died from signal ${exit - 128}`;
  throw new Error(why + stderr);
}

export function failureReason(code: FailureCode, agentTimeoutMs: number): string {
  switch (code) {
    case "timeout":
      return `the investigation hit the ${Math.round(agentTimeoutMs / 60_000)}-minute limit`;
    case "no_submission":
    case "invalid_submission":
    case "invalid_input":
    case "agent_error":
      return "the agent stopped without submitting an answer";
    case "retries_exhausted":
      return "the investigation kept failing on infrastructure errors";
    case "misconfigured":
      return "the investigation service is misconfigured (an operator needs to check the workflow's settings)";
    case "snapshot_not_ready":
      return "the repository snapshot isn't ready: a build is still running (about 5 minutes) or the last one failed; try again shortly";
    case "no_snapshot":
      return (
        "no repository snapshot is available: the first build hasn't finished, or recent builds failed and the last " +
        "snapshot expired. Try again in a few minutes; if this keeps happening, an operator should check the snapshot cron's logs"
      );
    case "invalid_question":
      return `the question couldn't be read (a conversation holds at most ${TRANSCRIPT_MAX_MESSAGES} messages of up to ${MESSAGE_MAX_CHARS} characters each)`;
  }
}

/** The parts of the input needed to deliver a reply, read on their own when the transcript is invalid. */
const DeliveryInput = AnswerQuestionInput.pick({ callback: true, metadata: true });

export function filterEvidence(
  result: InvestigationResult,
  manifest: RepoManifest,
): { result: InvestigationResult; dropped: Evidence[] } {
  if (result.status !== "final_answer") return { result, dropped: [] };
  const kept: Evidence[] = [];
  const dropped: Evidence[] = [];
  for (const e of result.evidence) {
    const repo = manifest.repos.find(
      (r) => r.repository.toLowerCase() === e.repository.toLowerCase() && r.commit.startsWith(e.commit),
    );
    if (!repo) {
      dropped.push(e);
      continue;
    }
    const pinned = { ...e, repository: repo.repository, commit: repo.commit };
    kept.push({ ...pinned, url: buildEvidenceUrl(pinned, repo.browse, repo.url) });
  }
  return { result: { ...result, evidence: kept }, dropped };
}

const MAX_STDERR_LOG = 2_048;
export type InvestigateInput = { transcript: Transcript; trace_id: string };

export type InvestigateResult =
  | { kind: "result"; result: InvestigationResult; model: string; prompt_version: string; usage?: Usage; manifest_created_at: string; repos: Array<{ repository: string; commit: string }> }
  | { kind: "failed"; code: FailureCode };

export type DeliverInput = {
  callback: Callback;
  body: string;
};

export type AnswerQuestionDeps = {
  config: Config;
  log: Log;
  runInvestigate: (input: InvestigateInput) => Promise<InvestigateResult>;
  runDeliver: (input: DeliverInput) => Promise<void>;
};

export type AnswerQuestionResult = {
  trace_id: string;
  outcome: string;
  reply: Reply;
};

export async function answerQuestion(
  deps: AnswerQuestionDeps,
  traceId: string,
  rawInput: unknown,
): Promise<AnswerQuestionResult> {
  const { config, log } = deps;
  const started = Date.now();

  const parsed = AnswerQuestionInput.safeParse(rawInput);
  // Without a reply, a caller waiting on its callback would wait forever.
  const input: z.infer<typeof DeliveryInput> = parsed.success ? parsed.data : DeliveryInput.safeParse(rawInput).data ?? {};

  let investigateResult: InvestigateResult;
  if (!parsed.success) {
    log.warn("invalid question", { event: "invalid_question", trace_id: traceId, error: z.prettifyError(parsed.error) });
    investigateResult = { kind: "failed", code: "invalid_question" };
  } else {
    try {
      investigateResult = await deps.runInvestigate({ transcript: parsed.data.transcript, trace_id: traceId });
    } catch (err) {
      log.error("investigation failed", { trace_id: traceId, err });
      investigateResult = { kind: "failed", code: "retries_exhausted" };
    }
  }

  let reply: Reply;
  if (investigateResult.kind === "result") {
    const r = investigateResult.result;
    reply = r.status === "needs_clarification"
      ? { kind: "clarification", traceId, result: r }
      : {
          kind: "answer",
          traceId,
          result: r,
          model: investigateResult.model,
          manifestCreatedAt: investigateResult.manifest_created_at,
        };
  } else {
    reply = { kind: "failure", traceId, reason: failureReason(investigateResult.code, config.agentTimeoutMs) };
  }

  if (input.callback) {
    const body = JSON.stringify({
      trace_id: traceId,
      reply,
      metadata: input.metadata,
    });
    try {
      await deps.runDeliver({ callback: input.callback, body });
    } catch (err) {
      log.error("deliver failed", { event: "deliver_failed", trace_id: traceId, err });
    }
  }

  const outcome = reply.kind;
  const durationMs = Date.now() - started;
  log.info("turn finished", {
    event: "turn_finished",
    trace_id: traceId,
    outcome,
    model: investigateResult.kind === "result" ? investigateResult.model : undefined,
    prompt_version: investigateResult.kind === "result" ? investigateResult.prompt_version : undefined,
    repos: investigateResult.kind === "result" ? investigateResult.repos : undefined,
    usage: investigateResult.kind === "result" ? investigateResult.usage : undefined,
    cost_usd: investigateResult.kind === "result" ? investigateResult.usage?.cost_usd : undefined,
    duration_ms: durationMs,
  });

  return { trace_id: traceId, outcome, reply };
}

/** POST the callback body with a signed request. Throws on non-2xx or network error. */
export async function deliverCallback(input: DeliverInput): Promise<void> {
  const { signature, timestamp } = signCallback(input.callback.secret, input.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(input.callback.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Researcher-Timestamp": String(timestamp),
        "X-Researcher-Signature": signature,
      },
      body: input.body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`deliver got ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export type InvestigateDeps = {
  config: Config;
  log: Log;
  configureSandboxes: (allowedDomain: string) => Promise<OpenSandbox>;
};

export async function investigateTask(
  deps: InvestigateDeps,
  input: InvestigateInput,
): Promise<InvestigateResult> {
  const { config, log } = deps;

  const record = getBuiltinModel(config.modelProvider as never, config.model as never);
  if (!record) {
    log.warn("unknown model", { event: "workflow_misconfigured", provider: config.modelProvider, model: config.model });
    return { kind: "failed", code: "misconfigured" };
  }
  const allowedDomain = new URL(record.baseUrl).hostname;

  let openSandbox: OpenSandbox;
  try {
    openSandbox = await deps.configureSandboxes(allowedDomain);
  } catch (err) {
    log.warn("sandbox setup failed", { event: "workflow_misconfigured", err });
    return { kind: "failed", code: "misconfigured" };
  }

  let sandbox: Sandbox;
  try {
    sandbox = await openSandbox(config.snapshotName, { timeoutMs: config.sandboxProvisionTimeoutMs });
  } catch (err) {
    if (err instanceof SnapshotUnavailableError) return { kind: "failed", code: err.notReady ? "snapshot_not_ready" : "no_snapshot" };
    if (err instanceof SandboxMisconfiguredError) {
      log.warn("sandbox settings rejected", { event: "workflow_misconfigured", err });
      return { kind: "failed", code: "misconfigured" };
    }
    throw err;
  }
  log.info("sandbox ready", { sandbox_id: sandbox.id, ...sandbox.info });

  try {
    const redact = (text: string) => (config.modelApiKey ? text.replaceAll(config.modelApiKey, "[redacted]") : text);
    const runnerInput = RunnerInput.parse({
      trace_id: input.trace_id,
      transcript: input.transcript,
      manifest: sandbox.manifest,
      repos_root: sandbox.reposRoot,
      scratch_dir: sandbox.scratchDir,
      model_provider: config.modelProvider,
      model: config.model,
      thinking_level: config.thinkingLevel,
      timeout_ms: config.agentTimeoutMs,
    });

    const startedAt = Date.now();
    const run = await sandbox.run({
      input: runnerInput,
      modelApiKey: config.modelApiKey,
      timeoutMs: config.agentTimeoutMs,
      onStderr: (chunk: string) => {
        const text = redact(chunk);
        const truncated = Math.max(text.length - MAX_STDERR_LOG, 0);
        log.info("runner stderr", { chunk: text.slice(0, MAX_STDERR_LOG), ...(truncated && { truncated }) });
      },
    });
    const capture = captureRun(run.events);
    const verdict = classifyRun(
      { ...run, stderrTail: redact(run.stderrTail).slice(-MAX_STDERR_LOG) },
      capture,
      { elapsedMs: Date.now() - startedAt, agentTimeoutMs: config.agentTimeoutMs },
    );
    if (verdict.kind === "failed") {
      log.warn("investigation failed", {
        event: "investigation_failed",
        trace_id: input.trace_id,
        code: verdict.code,
        message: redact(verdict.message),
      });
      return { kind: "failed", code: verdict.code };
    }

    const { result, dropped } = filterEvidence(verdict.value, runnerInput.manifest);
    if (dropped.length > 0) log.warn("dropped evidence not in the sandbox manifest", { dropped });
    return {
      kind: "result",
      result,
      model: capture.started?.model ?? config.model,
      prompt_version: capture.started?.prompt_version ?? "unknown",
      usage: capture.usage,
      manifest_created_at: sandbox.manifest.created_at,
      repos: sandbox.manifest.repos.map((r) => ({ repository: r.repository, commit: r.commit })),
    };
  } finally {
    await sandbox.close().catch((err: unknown) =>
      log.warn("could not terminate sandbox", { sandbox_id: sandbox.id, err }),
    );
  }
}
