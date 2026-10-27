import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { type Evidence, InvestigationResult } from "../investigation.ts";
import type { RunnerInput } from "./protocol.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const SUBMIT_TOOL = "submit_investigation";
export const MAX_SUBMIT_ATTEMPTS = 3;

const FINAL = "final_answer only.";
const EvidenceParam = Type.Object({
  repository: Type.String({ description: "owner/name exactly as listed in the manifest" }),
  commit: Type.String({ description: "That repository's manifest commit SHA (full, or a prefix of at least 7 characters)" }),
  path: Type.String({ description: "File path relative to the repository root" }),
  start_line: Type.Integer({ description: "First cited line (1-based)" }),
  end_line: Type.Integer({ description: "Last cited line, inclusive; at most the file's line count" }),
});

// Flat on purpose: Pi's Anthropic adapter sends only top-level `properties`, so a top-level union would reach
// the model as a tool without parameters. The union is enforced in execute() with the contracts schema.
export const SubmitParams = Type.Object({
  status: StringEnum(["needs_clarification", "final_answer"] as const, {
    description:
      "needs_clarification: send question and why_needed only. final_answer: send answer, confidence, observed_in_code, " +
      "inferred_behavior, not_established, evidence, suggested_owner and escalation_question (all required).",
  }),
  question: Type.Optional(Type.String({ description: "needs_clarification only. One specific question the user can answer in a sentence." })),
  why_needed: Type.Optional(Type.String({ description: "needs_clarification only. Which code paths diverge on the answer." })),
  answer: Type.Optional(Type.String({ description: `${FINAL} Two to four sentences answering the question directly.` })),
  confidence: Type.Optional(StringEnum(["high", "medium", "low"] as const, { description: FINAL })),
  observed_in_code: Type.Optional(Type.Array(Type.String(), { description: `${FINAL} Behavior directly established by code you read; each needs evidence.` })),
  inferred_behavior: Type.Optional(Type.Array(Type.String(), { description: `${FINAL} Conclusions that follow from code but were not observed.` })),
  not_established: Type.Optional(Type.Array(Type.String(), { description: `${FINAL} What the repositories cannot settle.` })),
  evidence: Type.Optional(Type.Array(EvidenceParam, { description: `${FINAL} Exact, tight line ranges from manifest repositories.` })),
  suggested_owner: Type.Optional(Type.String({ description: `${FINAL} Team or area most likely to own the behavior.` })),
  escalation_question: Type.Optional(Type.String({ description: `${FINAL} The smallest unresolved question for Engineering.` })),
});

type Checkouts = Pick<RunnerInput, "manifest" | "repos_root">;
export type Verdict = { ok: true; result: InvestigationResult } | { ok: false; problems: string[] };

/** Validates against the contracts schema, then checks every citation against the manifest and the checkout. */
export function validateSubmission(candidate: unknown, checkouts: Checkouts): Verdict {
  const parsed = InvestigationResult.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const result = parsed.data;
  if (result.status === "needs_clarification") return { ok: true, result };

  const problems: string[] = [];
  if (result.observed_in_code.length > 0 && result.evidence.length === 0) {
    problems.push(
      `evidence: observed_in_code has ${result.observed_in_code.length} claim(s) but evidence is empty; cite the lines that support them`,
    );
  }
  const evidence = result.evidence.map((e, i) => checkEvidence(e, `evidence[${i}]`, checkouts, problems));
  return problems.length > 0 ? { ok: false, problems } : { ok: true, result: { ...result, evidence } };
}

function checkEvidence(e: Evidence, label: string, { manifest, repos_root }: Checkouts, problems: string[]): Evidence {
  const repo = manifest.repos.find((r) => r.repository === e.repository);
  if (!repo) {
    const known = manifest.repos.map((r) => r.repository).join(", ");
    problems.push(`${label}.repository: "${e.repository}" is not in the manifest (${known})`);
    return { repository: e.repository, commit: e.commit, path: e.path, start_line: e.start_line, end_line: e.end_line };
  }
  if (!repo.commit.startsWith(e.commit)) {
    problems.push(`${label}.commit: "${e.commit}" is not the manifest commit for ${repo.repository} (${repo.commit})`);
  }
  if (e.start_line > e.end_line) {
    problems.push(`${label}: start_line ${e.start_line} is after end_line ${e.end_line}`);
  }
  const file = inspectFile(join(repos_root, repo.repository), e.path, repo.repository, repo.commit);
  if ("problem" in file) {
    problems.push(`${label}.path: ${file.problem}`);
  } else if (e.end_line > file.lines) {
    problems.push(`${label}.end_line: ${e.end_line} is past the end of ${repo.repository}/${file.path} (${file.lines} lines)`);
  }
  const path = "path" in file ? file.path : e.path;
  return { repository: e.repository, commit: repo.commit, path, start_line: e.start_line, end_line: e.end_line };
}

type FileInspection = { path: string; lines: number } | { problem: string };
const MAX_CITATION_BYTES = 16 * 1024 * 1024;
const GIT_READ_TIMEOUT_MS = 5_000;

function inspectFile(repoDir: string, path: string, repository: string, commit: string): FileInspection {
  if (isAbsolute(path)) {
    const hint = path.startsWith(repoDir + sep) ? ` (did you mean "${relative(repoDir, path)}"?)` : "";
    return { problem: `"${path}" must be relative to the repository root${hint}` };
  }
  if (path.split(/[\\/]/).includes("..")) return { problem: `"${path}" must not contain ".."` };
  const normalized = posix.normalize(path).replace(/^\.\//, "");
  if (normalized.split("/").includes(".git")) return { problem: `"${path}" is inside .git` };

  let root: string;
  let real: string;
  try {
    root = realpathSync(repoDir);
    real = realpathSync(resolve(root, normalized));
  } catch {
    const hint = normalized.startsWith(`${repository}/`) ? ` (paths are relative to the repository root; try "${normalized.slice(repository.length + 1)}")` : "";
    return { problem: `"${path}" does not exist in ${repository}${hint}` };
  }
  if (real !== root && !real.startsWith(root + sep)) return { problem: `"${path}" resolves outside ${repository}` };
  const canonical = relative(root, real).split(sep).join("/");
  if (canonical.split("/").includes(".git")) return { problem: `"${path}" resolves inside .git` };
  try {
    if (!statSync(real).isFile()) return { problem: `"${path}" is not a regular file` };
  } catch {
    return { problem: `"${path}" cannot be inspected in ${repository}` };
  }

  try {
    const entry = readGit(repoDir, ["ls-tree", "-l", "-z", "--full-tree", commit, "--", canonical]).toString("utf8");
    const tracked = /^(100644|100755) blob ([0-9a-f]{40}) +(\d+)\t([\s\S]+)\0$/.exec(entry);
    if (!tracked || tracked[4] !== canonical) {
      return { problem: `"${path}" resolves to "${canonical}", which is not a tracked regular file at manifest commit ${commit}` };
    }
    if (Number(tracked[3]) > MAX_CITATION_BYTES) {
      return { problem: `"${path}" exceeds the ${MAX_CITATION_BYTES / 1024 / 1024} MiB citation-validation limit` };
    }
    // Count the exact blob the URL will cite, rather than a symlink blob or a later working-tree version.
    const content = readGit(repoDir, ["cat-file", "blob", tracked[2]!]);
    return { path: canonical, lines: countLines(content) };
  } catch {
    return { problem: `"${path}" cannot be read at manifest commit ${commit} (Git reads must finish within ${GIT_READ_TIMEOUT_MS} ms and ${MAX_CITATION_BYTES / 1024 / 1024} MiB)` };
  }
}

/** Read local objects without shell interpolation, checkout filters, ambient auth, or lazy network fetches. */
function readGit(repoDir: string, args: string[]): Buffer {
  return execFileSync("git", [
    "--no-pager", "--literal-pathspecs", "--no-optional-locks",
    "-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
    "-C", repoDir, ...args,
  ], {
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "",
    },
    timeout: GIT_READ_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: MAX_CITATION_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let lines = 0;
  for (const byte of content) if (byte === 0x0a) lines++;
  return content[content.length - 1] === 0x0a ? lines : lines + 1;
}

export interface SubmitHandlers {
  onAccepted(result: InvestigationResult): void;
  /** Called with the number of rejected attempts so far. */
  onRejected(attempts: number): void;
}

export function createSubmitTool(checkouts: Checkouts, handlers: SubmitHandlers): AgentTool<typeof SubmitParams, InvestigationResult> {
  let accepted: InvestigationResult | undefined;
  let rejected = 0;
  return {
    name: SUBMIT_TOOL,
    label: "Submit investigation",
    description:
      "Submit the result of the investigation. Call exactly once, as your final action, on its own. Every citation is " +
      "checked against the manifest and the checkout: the repository must be in the manifest, commit must be its manifest " +
      "commit, path must resolve to a tracked regular source file inside the repository, and the line range must exist " +
      "in its manifest-commit blob. Contained source symlinks are recorded with the target path; .git targets are rejected. " +
      `A rejected submission records nothing; fix every listed problem and call again (${MAX_SUBMIT_ATTEMPTS} attempts in total).`,
    parameters: SubmitParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (accepted) {
        return { content: [{ type: "text", text: "Already submitted; this call was ignored." }], details: accepted, terminate: true };
      }
      const verdict = validateSubmission(params, checkouts);
      if (!verdict.ok) {
        rejected++;
        handlers.onRejected(rejected);
        const remaining = MAX_SUBMIT_ATTEMPTS - rejected;
        throw new Error(
          `${SUBMIT_TOOL} rejected (attempt ${rejected} of ${MAX_SUBMIT_ATTEMPTS}); nothing was recorded. ` +
            (remaining > 0 ? "Fix every problem below and call it again:\n" : "No attempts remain:\n") +
            verdict.problems.map((p) => `- ${p}`).join("\n"),
        );
      }
      accepted = verdict.result;
      handlers.onAccepted(verdict.result);
      return { content: [{ type: "text", text: "Submission recorded. The investigation is complete." }], details: verdict.result, terminate: true };
    },
  };
}
