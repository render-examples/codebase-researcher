import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildRunner, CLARIFY, call, finalAnswer, makeCitationFixture, makeFixture, makeInput, parseEvents, REPO, RUNNER_DIR, runCli, runScripted, say, terminal, toolResults } from "./helpers.ts";
import { apiKeyFor, takeCredentials } from "../src/runner/main.ts";
import { validateSubmission } from "../src/runner/submit.ts";
import { rejectReason } from "../src/runner/tools.ts";

const SUBMIT = "submit_investigation";

let runnerDir: string;

beforeAll(async () => {
  runnerDir = dirname(await buildRunner());
}, 60_000);

afterAll(() => rm(runnerDir, { recursive: true, force: true }));

describe("bundled runner CLI", { timeout: 30_000 }, () => {
  it("a --faux run uses the real tools on the checkout and ends with exactly one cited final_answer", () => {
    const fx = makeFixture();
    const { code, stdout, stderr } = runCli(["--faux"], JSON.stringify(makeInput(fx)));
    const events = parseEvents(stdout);

    expect(events[0]?.type).toBe("started");
    expect(toolResults(events).map((r) => [r.tool, r.is_error])).toEqual([
      ["ls", false],
      ["bash", false],
      ["read", false],
      [SUBMIT, false],
    ]);
    expect(terminal(events)).toMatchObject({
      type: "result",
      result: { status: "final_answer", evidence: [{ repository: REPO, commit: fx.commit, path: "README.md" }] },
    });
    expect(code, stderr).toBe(0);
  });

  it("asks for clarification, then answers once the user replies", () => {
    const fx = makeFixture();
    const first = makeInput(fx, { text: "Please clarify how retries work" });
    const end1 = terminal(parseEvents(runCli(["--faux"], JSON.stringify(first)).stdout));
    expect(end1).toMatchObject({ type: "result", result: { status: "needs_clarification" } });

    const second = {
      ...first,
      transcript: [
        ...first.transcript,
        { role: "agent", text: "Which service type?" },
        { role: "user", text: "Web services in Oregon." },
      ],
    };
    const end2 = terminal(parseEvents(runCli(["--faux"], JSON.stringify(second)).stdout));
    expect(end2).toMatchObject({ type: "result", result: { status: "final_answer" } });
  });

  it("rejects bad arguments and invalid input with invalid_input and exit 2", () => {
    const fx = makeFixture();
    const input = makeInput(fx);
    const cases: Array<[string, string[], string]> = [
      ["unknown flag", ["--faux", "--bogus"], JSON.stringify(input)],
      ["stdin is not JSON", ["--faux"], "{nope"],
      ["missing manifest", ["--faux"], JSON.stringify({ ...input, manifest: undefined })],
      ["unknown model", ["--faux"], JSON.stringify({ ...input, model: "claude-imaginary-9" })],
      ["repos_root is not a directory", ["--faux"], JSON.stringify({ ...input, repos_root: join(fx.scratchDir, "missing") })],
    ];
    for (const [name, args, stdin] of cases) {
      const { code, stdout } = runCli(args, stdin);
      expect(terminal(parseEvents(stdout)), name).toMatchObject({ type: "error", code: "invalid_input" });
      expect(code, name).toBe(2);
    }
  });

  it("fails with agent_error and exit 1 when there is no API key or the model request fails", async () => {
    const fx = makeFixture();
    const noKey = runCli([], JSON.stringify(makeInput(fx)));
    expect(terminal(parseEvents(noKey.stdout))).toMatchObject({ type: "error", code: "agent_error" });
    expect(noKey.code).toBe(1);

    const modelError = await runScripted(makeInput(fx), () => [
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "authentication_error: invalid x-api-key" }),
    ]);
    expect(terminal(modelError.events)).toMatchObject({ type: "error", code: "agent_error" });
    expect(modelError.code).toBe(1);
  });

  it("--self-test reports ok with its versions, without input or network", () => {
    const { code, stdout } = runCli(["--self-test"], "");
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, pi_version: expect.any(String), prompt_version: expect.any(String) });
    expect(code).toBe(0);
  });
});

describe("credentials", { timeout: 30_000 }, () => {
  it("takeCredentials deletes the key file and removes every provider's key vars from the env", () => {
    const fx = makeFixture();
    const keyFile = join(fx.scratchDir, "model.key");
    writeFileSync(keyFile, "sk-file-key\n");
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_OAUTH_TOKEN: "oauth", OPENAI_API_KEY: "sk-openai", PATH: "/bin" };

    const fromFile = takeCredentials(keyFile, env);
    expect(existsSync(keyFile)).toBe(false);
    expect(env).toEqual({ PATH: "/bin" });
    expect(apiKeyFor(fromFile, "openai")).toBe("sk-file-key");

    const fromEnv = takeCredentials(undefined, { ANTHROPIC_API_KEY: " sk-ant ", OPENAI_API_KEY: "sk-openai" });
    expect(apiKeyFor(fromEnv, "anthropic")).toBe("sk-ant");
    expect(apiKeyFor(fromEnv, "google")).toBeUndefined();
  });

  // The shell writes its observations to a file: Pi stops reading stdout 100 ms after exit, so a busy run can lose it.
  it("the bash tool rejects policy violations and runs other commands with an allowlisted env and no credentials in reach", async () => {
    const fx = makeFixture();
    const keyFile = join(fx.scratchDir, "..", "model.key");
    writeFileSync(keyFile, "sk-ant-test-FILEKEY-0123456789\n");
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-ENVKEY-9876543210";
    process.env.RENDER_API_KEY = "rnd-not-for-the-model";
    try {
      const { code, events } = await runScripted(
        makeInput(fx),
        () => [
          call("bash", { command: "git checkout -b evil" }),
          call("bash", { command: `(test -e ${keyFile} && echo KEY_FILE_PRESENT || echo KEY_FILE_ABSENT; env) > $HOME/env.txt` }),
          call(SUBMIT, CLARIFY),
        ],
        ["--key-file", keyFile],
      );

      expect(toolResults(events).map((r) => r.is_error)).toEqual([true, false, false]);
      const env = readFileSync(join(fx.scratchDir, "env.txt"), "utf8");
      expect(env).toContain("KEY_FILE_ABSENT");
      expect(env).toContain(`HOME=${fx.scratchDir}`);
      for (const leaked of ["sk-ant", "ANTHROPIC", "RENDER_API_KEY"]) expect(env).not.toContain(leaked);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(code).toBe(0);
    } finally {
      delete process.env.RENDER_API_KEY;
    }
  });

  it("redacts the file and env API keys from every emitted event", async () => {
    const fx = makeFixture();
    const keyFile = join(fx.scratchDir, "..", "model.key");
    const fileKey = "sk-ant-test-FILEKEY-0123456789";
    const envKey = "sk-openai-test-ENVKEY-9876543210";
    writeFileSync(keyFile, `${fileKey}\n`);
    process.env.OPENAI_API_KEY = envKey;

    const { stdout, events } = await runScripted(
      makeInput(fx),
      () => [call("bash", { command: `echo ${fileKey} ${envKey}` }), call(SUBMIT, { ...CLARIFY, question: `Is ${fileKey} yours?` })],
      ["--key-file", keyFile],
    );

    expect(toolResults(events)[0]?.is_error).toBe(false);
    expect(terminal(events).type).toBe("result");
    expect(stdout).not.toContain(fileKey);
    expect(stdout).not.toContain(envKey);
    expect(stdout).toContain("[REDACTED]");
  });
});

describe("run outcomes", { timeout: 30_000 }, () => {
  it("stops at the deadline with a timeout error and exit 3, without waiting for running commands", async () => {
    const fx = makeFixture();
    const startedAt = Date.now();
    const { code, events } = await runScripted(makeInput(fx, { timeout_ms: 12_000 }), () =>
      Array.from({ length: 10 }, () => call("bash", { command: "sleep 5" })),
    );
    expect(terminal(events)).toMatchObject({ type: "error", code: "timeout" });
    expect(code).toBe(3);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("reminds a model that stops without submitting once, then fails with no_submission", async () => {
    const fx = makeFixture();
    const recovered = await runScripted(makeInput(fx), () => [say("Here is my answer in prose."), call(SUBMIT, CLARIFY)]);
    expect(terminal(recovered.events)).toMatchObject({ type: "result", result: CLARIFY });
    expect(recovered.code).toBe(0);

    const silent = await runScripted(makeInput(fx), () => [say("prose"), say("more prose")]);
    expect(terminal(silent.events)).toMatchObject({ type: "error", code: "no_submission" });
    expect(silent.code).toBe(1);
  });

  it("lets the model fix a rejected submission, and fails with invalid_submission after three rejections", async () => {
    const fx = makeFixture();
    const bad = finalAnswer([{ repository: REPO, commit: fx.commit, path: "missing.ts", start_line: 1, end_line: 1 }]);
    const good = finalAnswer([{ repository: REPO, commit: fx.commit, path: "src/retry.ts", start_line: 1, end_line: 2 }]);

    const fixed = await runScripted(makeInput(fx), () => [call(SUBMIT, bad), call(SUBMIT, good)]);
    expect(toolResults(fixed.events).map((r) => r.is_error)).toEqual([true, false]);
    expect(terminal(fixed.events)).toMatchObject({ type: "result", result: { status: "final_answer" } });
    expect(fixed.code).toBe(0);

    let extraCalls = 0;
    const exhausted = await runScripted(makeInput(fx), () => [
      call(SUBMIT, bad),
      call(SUBMIT, bad),
      call(SUBMIT, bad),
      () => (extraCalls++, call(SUBMIT, good)),
    ]);
    expect(toolResults(exhausted.events).map((r) => r.is_error)).toEqual([true, true, true]);
    expect(terminal(exhausted.events)).toMatchObject({ type: "error", code: "invalid_submission" });
    expect(exhausted.code).toBe(1);
    expect(extraCalls).toBe(0);
  });
});

describe("read-only shell policy", () => {
  it("rejects mutating git, network, install, and sudo commands, including inside subshells and wrappers, and allows read-only inspection", () => {
    const ctx = { scratchDir: "/scratch" };
    const rejected = [
      "git checkout -b evil",
      "git log -1; git push origin main",
      "git -c core.fsmonitor=evil status",
      "git branch evil",
      "curl https://example.com",
      'echo "$(wget -qO- https://example.com)"',
      'bash -c "git stash"',
      "timeout 5 ssh host",
      "npm install left-pad",
      "sudo ls",
      `chmod -R 777 ${REPO}`,
    ];
    const allowed = [
      `git -C ${REPO} log -1 --format=%H`,
      `git -C ${REPO} blame -L 1,2 README.md | head -2`,
      "git branch --contains HEAD",
      `rg -n "curl|wget" ${REPO}`,
      'echo "a; curl b"',
      "chmod +x /scratch/check.sh",
      "npm ls",
    ];
    expect(rejected.filter((command) => rejectReason(command, ctx) === undefined)).toEqual([]);
    expect(allowed.filter((command) => rejectReason(command, ctx) !== undefined)).toEqual([]);
  });
});

describe("citation validation", () => {
  const fx = makeFixture();
  const checkouts = { manifest: makeInput(fx).manifest, repos_root: fx.reposRoot };
  const cite = (over: Record<string, unknown>) => finalAnswer([{ repository: REPO, commit: fx.commit, path: "README.md", start_line: 1, end_line: 3, ...over }]);

  it("accepts clarifications and valid citations, pinning them to the full manifest commit and a clean path", () => {
    expect(validateSubmission(CLARIFY, checkouts).ok).toBe(true);
    expect(validateSubmission(finalAnswer([], []), checkouts).ok).toBe(true);

    const v = validateSubmission(cite({ commit: fx.commit.slice(0, 7), path: "./src/retry.ts", end_line: 2, url: "https://evil.example.com" }), checkouts);
    expect(v.ok && v.result.status === "final_answer" && v.result.evidence).toEqual([
      { repository: REPO, commit: fx.commit, path: "src/retry.ts", start_line: 1, end_line: 2 },
    ]);
  });

  it("rejects citations outside the manifest, the manifest commit, the checkout's files, or the file's lines, and observed claims without evidence", () => {
    const cases: Array<[string, unknown, string]> = [
      ["repository not in the manifest", cite({ repository: "acme/other" }), "evidence[0].repository"],
      ["commit other than the manifest commit", cite({ commit: "deadbeef" }), "evidence[0].commit"],
      ["absolute path", cite({ path: `${fx.repoDir}/README.md` }), "evidence[0].path"],
      ["path with ..", cite({ path: "../../outside.txt" }), "evidence[0].path"],
      ["symlink escaping the repo", cite({ path: "escape.txt" }), "evidence[0].path"],
      ["file inside .git", cite({ path: ".git/HEAD" }), "evidence[0].path"],
      ["directory", cite({ path: "src" }), "evidence[0].path"],
      ["missing file", cite({ path: "missing.ts" }), "evidence[0].path"],
      ["range past the end of the file", cite({ end_line: 13 }), "evidence[0].end_line"],
      ["start after end", cite({ start_line: 5, end_line: 4 }), "evidence[0]"],
      ["observed claims without evidence", finalAnswer([]), "evidence"],
    ];
    for (const [name, candidate, field] of cases) {
      const v = validateSubmission(candidate, checkouts);
      expect(v.ok ? [] : v.problems.map((p) => p.slice(0, p.indexOf(":"))), name).toEqual([field]);
    }
  });
});

describe("symlink citations", () => {
  const fx = makeCitationFixture();
  const checkouts = { manifest: makeInput(fx).manifest, repos_root: fx.reposRoot };
  const cite = (path: string) => finalAnswer([{ repository: REPO, commit: fx.commit.slice(0, 7), path, start_line: 2, end_line: 3 }]);
  afterAll(() => rm(dirname(fx.reposRoot), { recursive: true, force: true }));

  it.each(["source-alias.ts", "source-chain.ts", "source-dir/source.ts", "nested/source-dir/source.ts", "./src//source.ts"])(
    "records the target path for %s", (path) => {
      const verdict = validateSubmission(cite(path), checkouts);
      expect(verdict.ok && verdict.result.status === "final_answer" && verdict.result.evidence).toEqual([
        { repository: REPO, commit: fx.commit, path: "src/source.ts", start_line: 2, end_line: 3 },
      ]);
    },
  );

  it.each([
    ["metadata.txt", "resolves inside .git"],
    ["metadata-dir/config", "resolves inside .git"],
    ["escape.txt", "resolves outside"],
    ["dangling.ts", "does not exist"],
    ["cycle-a.ts", "does not exist"],
    ["source-dir", "not a regular file"],
  ])("rejects %s", (path, message) => {
    const verdict = validateSubmission(cite(path), checkouts);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.problems[0]).toContain(message);
  });
});

const RUNNER_PACKAGES = new Set(["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "typebox", "zod"]);
const SHARED_MODULES = new Set(["investigation.ts", "manifest.ts", "util.ts"]);
const importsOf = (code: string) => [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);

describe("runner bundle architecture", () => {
  it("ships one runner.mjs importing only Node built-ins, built from runner modules with an allowlisted, acyclic import graph", () => {
    expect(readdirSync(runnerDir)).toEqual(["runner.mjs"]);
    const bundle = readFileSync(join(runnerDir, "runner.mjs"), "utf8");
    const bundleImports = [...bundle.matchAll(/^import\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1]!);
    expect(bundleImports.length).toBeGreaterThan(0);
    expect(bundleImports.filter((spec) => !isBuiltin(spec))).toEqual([]);

    const files = readdirSync(RUNNER_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
    const violations: string[] = [];
    const localDeps = new Map<string, string[]>();
    for (const file of files) {
      const specs = importsOf(readFileSync(join(RUNNER_DIR, file), "utf8"));
      localDeps.set(file, specs.flatMap((s) => (/^\.\/[^/]+\.ts$/.test(s) ? [s.slice(2)] : [])));
      for (const spec of specs) {
        if (spec.startsWith("node:") || spec.startsWith("./") || spec.endsWith("?raw")) continue;
        if (spec.startsWith("../") && SHARED_MODULES.has(spec.slice(3))) continue;
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        if (!spec.startsWith("../") && RUNNER_PACKAGES.has(pkg)) continue;
        violations.push(`${file} imports ${spec}`);
      }
    }
    for (const file of SHARED_MODULES) {
      for (const spec of importsOf(readFileSync(join(RUNNER_DIR, "..", file), "utf8"))) {
        if (spec === "zod" || (spec.startsWith("./") && SHARED_MODULES.has(spec.slice(2)))) continue;
        violations.push(`${file} imports ${spec}`);
      }
    }
    expect(violations).toEqual([]);

    const cycles: string[] = [];
    const visit = (file: string, path: string[]) => {
      if (path.includes(file)) return void cycles.push([...path.slice(path.indexOf(file)), file].join(" -> "));
      for (const dep of localDeps.get(file) ?? []) visit(dep, [...path, file]);
    };
    for (const file of files) visit(file, []);
    expect(cycles).toEqual([]);
  });
});
