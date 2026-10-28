import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerEvent, type RunnerInput } from "../src/runner/protocol.ts";
import { git } from "../src/sandbox/interface.ts";
import { writeRunnerBundle } from "../src/sandbox/runner-bundle.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxScript } from "../src/runner/faux.ts";
import { main } from "../src/runner/main.ts";

export const FAKE_RUNNER = fileURLToPath(new URL("./fixtures/fake-runner.mjs", import.meta.url));

const ident = ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false"];

/** Creates `<root>/<repository>` with one commit on `main`; returns its path and HEAD. */
export async function makeRepo(root: string, repository: string): Promise<{ path: string; commit: string }> {
  const path = join(root, repository);
  await mkdir(path, { recursive: true });
  await git(["init", "-q", "-b", "main"], { cwd: path });
  await writeFile(join(path, "README.md"), `# ${repository}\n`);
  await commitAll(path, "init");
  return { path, commit: await git(["rev-parse", "HEAD"], { cwd: path }) };
}

async function commitAll(path: string, message: string): Promise<string> {
  await git([...ident, "add", "-A"], { cwd: path });
  await git([...ident, "commit", "-q", "-m", message], { cwd: path });
  return git(["rev-parse", "HEAD"], { cwd: path });
}

export function runnerInput(layout: { reposRoot: string; scratchDir: string }, model = "fake-model"): RunnerInput {
  return {
    trace_id: "test-trace-00001",
    transcript: [{ role: "user", text: "does X happen?" }],
    manifest: {
      profile: "test",
      created_at: new Date().toISOString(),
      repos: [{ repository: "acme/widget", branch: "main", commit: "a".repeat(40), path: `${layout.reposRoot}/acme/widget` }],
    },
    repos_root: layout.reposRoot,
    scratch_dir: layout.scratchDir,
    model_provider: "anthropic",
    model,
    thinking_level: "medium",
    timeout_ms: 60_000,
  };
}

/** The fake runner reports what it observed in an assistant_text event. */
export function runnerReport(events: RunnerEvent[]): {
  key: string | null;
  keyPath: string | null;
  keyFileGone: boolean | null;
  keyInEnv: boolean;
  cwd: string;
  envKeys: string[];
} {
  const text = events.find((e) => e.type === "assistant_text");
  if (!text || text.type !== "assistant_text") throw new Error("no assistant_text event");
  return JSON.parse(text.text);
}

export const RUNNER_DIR = fileURLToPath(new URL("../src/runner/", import.meta.url));
export const REPO = "acme/widget";

let runnerPath: string | undefined;

/** Bundles the runner into a fresh temp dir, outside the repo, so no node_modules is reachable from it. */
export async function buildRunner(): Promise<string> {
  runnerPath = await writeRunnerBundle(mkdtempSync(join(tmpdir(), "runner-bundle-")));
  return runnerPath;
}

export interface Fixture {
  reposRoot: string;
  scratchDir: string;
  repoDir: string;
  commit: string;
}

/** A two-commit git checkout at `<reposRoot>/acme/widget` plus an escaping symlink and a file outside it. */
export function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "runner-test-"));
  const reposRoot = join(base, "repos");
  const scratchDir = join(base, "scratch");
  const repoDir = join(reposRoot, REPO);
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(scratchDir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repoDir, "README.md"), Array.from({ length: 12 }, (_, i) => `readme line ${i + 1}`).join("\n") + "\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  writeFileSync(join(repoDir, "src/retry.ts"), "export const MAX_DELAY_MS = 30_000;\nexport const backoff = (n: number) => Math.min(MAX_DELAY_MS, 500 * 2 ** n);\n");
  git("add", "-A");
  git("commit", "-q", "-m", "add retry");
  writeFileSync(join(reposRoot, "outside.txt"), "not part of any checkout\n");
  symlinkSync("../../outside.txt", join(repoDir, "escape.txt"));
  return { reposRoot, scratchDir, repoDir, commit: git("rev-parse", "HEAD") };
}

/** A committed corpus of symlinks to a source file, a directory, and repository metadata. */
export function makeCitationFixture(): Fixture {
  const fx = makeFixture();
  const g = (...args: string[]) => execFileSync("git", [...ident, "-C", fx.repoDir, ...args], { encoding: "utf8" }).trim();
  mkdirSync(join(fx.repoDir, "nested"));
  writeFileSync(join(fx.repoDir, "src/source.ts"), "first line\nsecond line\nthird line\n");
  const aliases = {
    "source-alias.ts": "src/source.ts",
    "source-chain.ts": "source-alias.ts",
    "source-dir": "src",
    "nested/source-dir": "../src",
    "metadata.txt": ".git/config",
    "metadata-dir": ".git",
    "dangling.ts": "missing.ts",
    "cycle-a.ts": "cycle-b.ts",
    "cycle-b.ts": "cycle-a.ts",
  };
  for (const [path, target] of Object.entries(aliases)) symlinkSync(target, join(fx.repoDir, path));
  g("add", "-A");
  g("commit", "-q", "-m", "add citation aliases");
  return { ...fx, commit: g("rev-parse", "HEAD") };
}

export function makeInput(fx: Fixture, overrides: { text?: string; timeout_ms?: number } = {}): RunnerInput {
  return {
    trace_id: randomUUID(),
    transcript: [{ role: "user", text: overrides.text ?? "How long is the max retry delay?" }],
    manifest: {
      profile: "test",
      created_at: new Date().toISOString(),
      repos: [{ repository: REPO, branch: "main", commit: fx.commit, path: REPO }],
    },
    repos_root: fx.reposRoot,
    scratch_dir: fx.scratchDir,
    model_provider: "anthropic",
    model: "claude-sonnet-4-5",
    thinking_level: "off",
    timeout_ms: overrides.timeout_ms ?? 60_000,
  };
}

/** Parses stdout JSONL, asserting every line is a valid RunnerEvent. */
export function parseEvents(stdout: string): RunnerEvent[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => RunnerEvent.parse(JSON.parse(line)));
}

export function terminal(events: RunnerEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "result" && last?.type !== "error") throw new Error(`last event is ${last?.type}, not terminal`);
  expectSingleTerminal(events);
  return last;
}

function expectSingleTerminal(events: RunnerEvent[]) {
  const count = events.filter((e) => e.type === "result" || e.type === "error").length;
  if (count !== 1) throw new Error(`expected exactly one terminal event, got ${count}`);
}

export function runCli(args: string[], stdin: string, env: NodeJS.ProcessEnv = {}) {
  if (!runnerPath) throw new Error("call buildRunner() in beforeAll first");
  const res = spawnSync(process.execPath, [runnerPath, ...args], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 60_000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Runs main() in-process with a scripted faux model. */
export async function runScripted(input: RunnerInput, script: FauxScript, extraArgs: string[] = []) {
  let stdout = "";
  const code = await main(["--faux", ...extraArgs], {
    stdin: Readable.from([JSON.stringify(input)]),
    write: async (chunk) => {
      stdout += chunk;
    },
    fauxScript: script,
  });
  return { code, stdout, events: parseEvents(stdout) };
}

const toolUse = { stopReason: "toolUse" } as const;
export const say = (text: string) => fauxAssistantMessage(text);
export const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), toolUse);
export const calls = (...c: Array<[string, Record<string, unknown>]>) =>
  fauxAssistantMessage(c.map(([name, args]) => fauxToolCall(name, args)), toolUse);

export const CLARIFY = { status: "needs_clarification", question: "Which region?", why_needed: "Routing differs by region." };

export function finalAnswer(evidence: Array<Record<string, unknown>>, observed = ["MAX_DELAY_MS caps the backoff at 30s."]) {
  return {
    status: "final_answer",
    answer: "The maximum retry delay is 30 seconds.",
    confidence: "high",
    observed_in_code: observed,
    inferred_behavior: [],
    not_established: ["Whether callers override the cap."],
    evidence,
    suggested_owner: "platform",
    escalation_question: "Confirm no caller overrides MAX_DELAY_MS.",
  };
}

export const toolResults = (events: RunnerEvent[]) => events.flatMap((e) => (e.type === "tool_result" ? [e] : []));
