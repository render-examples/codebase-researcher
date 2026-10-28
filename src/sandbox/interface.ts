import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RepoManifest } from "../manifest.ts";
import { RunnerEvent, type RunnerInput } from "../runner/protocol.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** One investigation's isolated environment, restored from the newest snapshot. */
export type Sandbox = {
  id: string;
  manifest: RepoManifest;
  reposRoot: string;
  scratchDir: string;
  /** Verification details worth logging: runner user, privilege drop, DNS, Pi and prompt versions. */
  info: Record<string, unknown>;
  /** Runs the runner once. Never throws for non-zero exits. */
  run(opts: RunInvestigationOptions): Promise<RunInvestigationResult>;
  /** Idempotent: a sandbox that no longer exists counts as closed. */
  close(): Promise<void>;
};

export type OpenSandboxOptions = {
  /** Deadline for restoring, booting, and verifying the sandbox. Local sandboxes restore nothing and ignore it. */
  timeoutMs: number;
};

/**
 * Opens a verified sandbox from the newest available snapshot with this name.
 * Throws `SnapshotUnavailableError` when there is none.
 */
export type OpenSandbox = (snapshotName: string, opts: OpenSandboxOptions) => Promise<Sandbox>;

export type RunInvestigationOptions = {
  /** `repos_root` and `scratch_dir` must come from the sandbox. */
  input: RunnerInput;
  /** Delivered to the runner as a file it deletes on read. Omitted only for local dev with ambient Pi auth. */
  modelApiKey?: string;
  /** Hard deadline, enforced where the runner runs and again client-side. */
  timeoutMs: number;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
};

export type RunInvestigationResult = {
  /** null when we stopped waiting or lost the run before learning its exit status. */
  exitCode: number | null;
  /** We stopped waiting: the caller's signal or the client-side deadline fired. */
  aborted: boolean;
  /** The runner's exit status could not be read and we did not abort (e.g. the sandbox died); its state is unknown. */
  streamLost: boolean;
  /** Last ~4 KB of stderr, for error records. */
  stderrTail: string;
  /** Everything the runner emitted, including partial output from a run that was killed or lost. */
  events: RunnerEvent[];
  /** Output lines that were not valid RunnerEvent JSON (including one cut off by a kill). */
  invalidLines: number;
};

/**
 * Thrown when no snapshot with the requested name is available: expired, pruned, or not yet built. `notReady`
 * means one exists but isn't available: its capture is still running or failed.
 */
export class SnapshotUnavailableError extends Error {
  override name = "SnapshotUnavailableError";
  readonly notReady: boolean;

  constructor(message: string, options?: ErrorOptions & { notReady?: boolean }) {
    super(message, options);
    this.notReady = options?.notReady ?? false;
  }
}

/** Thrown when the provider rejects the Sandbox settings themselves, such as the egress policy. Retrying won't help. */
export class SandboxMisconfiguredError extends Error {
  override name = "SandboxMisconfiguredError";
}

const STDERR_TAIL_CHARS = 4096;

export const appendStderrTail = (tail: string, chunk: string): string => (tail + chunk).slice(-STDERR_TAIL_CHARS);

/** Parses the runner's complete JSONL output; lines that are not valid RunnerEvents are counted, not returned. */
export function parseRunnerEvents(output: string): { events: RunnerEvent[]; invalidLines: number } {
  const events: RunnerEvent[] = [];
  let invalidLines = 0;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      invalidLines++;
      continue;
    }
    const parsed = RunnerEvent.safeParse(json);
    if (parsed.success) events.push(parsed.data);
    else invalidLines++;
  }
  return { events, invalidLines };
}

/** Runs git and resolves with trimmed stdout; rejects with stderr on non-zero exit. */
export function git(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout.trim());
      },
    );
  });
}

export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
