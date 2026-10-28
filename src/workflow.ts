import { present } from "./util.ts";
import { providerApiKey } from "./runner/providers.ts";
import { RunnerInput } from "./runner/protocol.ts";
import botConfig from "../config.ts";
import { configureSandboxes } from "./sandbox/index.ts";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { z } from "zod";
import { answerQuestion, deliverCallback, investigateTask, type InvestigateInput, type InvestigateResult, type DeliverInput } from "./tasks.ts";
import { createLog } from "./log.ts";
import { callbackOrigins } from "./callback.ts";

const MINUTE = 60_000;

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const INVESTIGATE_MAX_RETRIES = 2;
export const INVESTIGATE_WAIT_MS = 5_000;
export const INVESTIGATE_BACKOFF = 2;
export const INVESTIGATE_MARGIN_MS = 5 * MINUTE;

export const DELIVER_MAX_RETRIES = 8;
export const DELIVER_WAIT_MS = 2_000;
export const DELIVER_BACKOFF = 2;
export const DELIVER_TIMEOUT_S = 120;

const timeouts = {
  AGENT_TIMEOUT_MS: positiveInt(15 * MINUTE),
  SANDBOX_PROVISION_TIMEOUT_MS: positiveInt(5 * MINUTE),
};

/** Sandbox provision + agent run + margin for setup, the run's client-side grace and output download, and termination. */
export const investigateTimeoutMs = (t: { AGENT_TIMEOUT_MS: number; SANDBOX_PROVISION_TIMEOUT_MS: number }) =>
  t.SANDBOX_PROVISION_TIMEOUT_MS + t.AGENT_TIMEOUT_MS + INVESTIGATE_MARGIN_MS;

/** Needs only the timeout vars, so it's safe at module load, where tasks are registered. */
export function investigateTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return Math.ceil(investigateTimeoutMs(z.object(timeouts).parse(present(env))) / 1000);
}

/** Sum of geometric wait durations (backoff scaling). */
function totalRetryWaitMs(retries: number, waitMs: number, backoff: number): number {
  let total = 0;
  let w = waitMs;
  for (let i = 0; i < retries; i++) { total += w; w *= backoff; }
  return total;
}

/**
 * Parent task timeout: covers the worst case where both subtasks use all their retries.
 * investigate timeout × (retries + 1) + its retry waits
 * + deliver timeout × (retries + 1) + its retry waits
 * + a 1-minute margin
 */
export function parentTimeoutMs(t: { AGENT_TIMEOUT_MS: number; SANDBOX_PROVISION_TIMEOUT_MS: number }): number {
  const invTimeout = investigateTimeoutMs(t);
  const invTotal = invTimeout * (INVESTIGATE_MAX_RETRIES + 1) + totalRetryWaitMs(INVESTIGATE_MAX_RETRIES, INVESTIGATE_WAIT_MS, INVESTIGATE_BACKOFF);
  const dlvTotal = DELIVER_TIMEOUT_S * 1000 * (DELIVER_MAX_RETRIES + 1) + totalRetryWaitMs(DELIVER_MAX_RETRIES, DELIVER_WAIT_MS, DELIVER_BACKOFF);
  return invTotal + dlvTotal + MINUTE;
}

export function parentTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return Math.ceil(parentTimeoutMs(z.object(timeouts).parse(present(env))) / 1000);
}

const Env = z
  .looseObject({
    MODEL_PROVIDER: z.string().min(1).default("anthropic"),
    MODEL: z.string().min(1).default("claude-opus-5"),
    THINKING_LEVEL: RunnerInput.shape.thinking_level,
    ...timeouts,
  })
  .transform((e) => {
    const env = e as Record<string, string | undefined>;
    return {
      snapshotName: botConfig.snapshotName,
      modelProvider: e.MODEL_PROVIDER,
      model: e.MODEL,
      thinkingLevel: e.THINKING_LEVEL,
      modelApiKey: providerApiKey(e.MODEL_PROVIDER, env),
      agentTimeoutMs: e.AGENT_TIMEOUT_MS,
      sandboxProvisionTimeoutMs: e.SANDBOX_PROVISION_TIMEOUT_MS,
      callbackOrigins: callbackOrigins(env),
    };
  });
export type Config = z.output<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(present(env));
}

const investigateSubtask = task(
  {
    name: "investigate",
    timeoutSeconds: investigateTimeoutSeconds(),
    retry: { maxRetries: INVESTIGATE_MAX_RETRIES, waitDurationMs: INVESTIGATE_WAIT_MS, backoffScaling: INVESTIGATE_BACKOFF },
  },
  async (_ctx: TaskContext, input: InvestigateInput): Promise<InvestigateResult> => {
    const log = createLog({ task: "investigate" });
    return investigateTask({
      config: loadConfig(),
      log,
      configureSandboxes: (allowedDomain) => configureSandboxes(process.env, log, allowedDomain),
    }, input);
  },
);

const deliverSubtask = task(
  {
    name: "deliver",
    timeoutSeconds: DELIVER_TIMEOUT_S,
    retry: { maxRetries: DELIVER_MAX_RETRIES, waitDurationMs: DELIVER_WAIT_MS, backoffScaling: DELIVER_BACKOFF },
  },
  async (_ctx: TaskContext, input: DeliverInput): Promise<void> => {
    return deliverCallback(input);
  },
);

export const answerQuestionTask = task(
  {
    name: "answer_question",
    timeoutSeconds: parentTimeoutSeconds(),
    retry: { maxRetries: 0, waitDurationMs: 0 },
  },
  async (ctx: TaskContext, input: unknown) => {
    const log = createLog({ task: "answer_question" });

    const traceId = ctx.metadata.taskRunId ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return answerQuestion(
      {
        config: loadConfig(),
        log,
        runInvestigate: (inv) => ctx.run(investigateSubtask, inv),
        runDeliver: (dlv) => ctx.run(deliverSubtask, dlv),
      },
      traceId,
      input,
    );
  },
);
