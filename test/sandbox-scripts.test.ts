import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, parseRunnerEvents, shq } from "../src/sandbox/interface.ts";
import { FAKE_RUNNER, makeRepo, runnerInput, runnerReport } from "./helpers.ts";

const SANDBOX = fileURLToPath(new URL("../sandbox/", import.meta.url));

let tmp: string;
let env: NodeJS.ProcessEnv;
let root: string;
let app: string;
let repo: string;
let layout: { reposRoot: string; scratchDir: string };

function bash(script: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("bash", [script, ...args], { env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

const chmodRepos = (mode: string) => execFileSync("chmod", ["-R", mode, layout.reposRoot]);

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "researcher-scripts-"));
  const shim = join(tmp, "shim");
  await mkdir(join(tmp, "home"), { recursive: true });
  await mkdir(shim);
  await writeFile(join(shim, "timeout"), '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  await writeFile(join(shim, "rg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  env = {
    PATH: `${shim}:${dirname(process.execPath)}:${process.env.PATH}`,
    HOME: join(tmp, "home"),
    GIT_CONFIG_GLOBAL: join(tmp, "home/.gitconfig"),
    GIT_CONFIG_SYSTEM: "/dev/null",
    DATABASE_URL: "postgres://must-not-leak",
  };

  root = join(tmp, "dx");
  app = join(root, "app");
  layout = { reposRoot: join(root, "repos"), scratchDir: join(root, "scratch") };
  const work = await makeRepo(join(tmp, "work"), "acme/widget");
  const remote = join(tmp, "remote/acme/widget.git");
  await git(["clone", "-q", "--bare", work.path, remote]);
  repo = join(layout.reposRoot, "acme/widget");
  await mkdir(dirname(repo), { recursive: true });
  await git(["clone", "-q", remote, repo]);
  await git(["-C", repo, "checkout", "-q", "--detach", work.commit]);
  for (const [key, value] of [["core.checkStat", "minimal"], ["core.trustctime", "false"], ["gc.auto", "0"]] as const) {
    await git(["-C", repo, "config", key, value]);
  }

  await mkdir(join(app, "runner"), { recursive: true });
  await mkdir(layout.scratchDir, { recursive: true });
  await cp(SANDBOX, app, { recursive: true });
  await cp(FAKE_RUNNER, join(app, "runner/runner.mjs"));
  const vars = {
    RESEARCHER_ROOT: root,
    RESEARCHER_APP_DIR: app,
    RESEARCHER_REPOS_ROOT: layout.reposRoot,
    RESEARCHER_SCRATCH_DIR: layout.scratchDir,
    RESEARCHER_RUN_AS: userInfo().username,
    RESEARCHER_DROP: "none",
    RESEARCHER_NODE: process.execPath,
    RESEARCHER_RUNNER_NODE: process.execPath,
    RESEARCHER_PATH: `${shim}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  await writeFile(join(app, "env"), Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join(""));
  await writeFile(
    join(app, "manifest.json"),
    JSON.stringify({ profile: "t", created_at: new Date().toISOString(), repos: [{ repository: "acme/widget", branch: "main", commit: work.commit, path: repo }] }),
  );
});

afterAll(async () => {
  execFileSync("chmod", ["-R", "u+w", tmp]);
  await rm(tmp, { recursive: true, force: true });
});

describe("verify.sh", { timeout: 30_000 }, () => {
  it("accepts read-only checkouts and reports that, as non-root, it couldn't confirm the runner is non-dumpable", async () => {
    chmodRepos("a-w");
    let res: Awaited<ReturnType<typeof bash>>;
    try {
      res = await bash(join(app, "verify.sh"), []);
    } finally {
      chmodRepos("u+w");
    }

    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      runAs: userInfo().username,
      runnerNonDumpable: false,
      selfTest: { ok: true, pi_version: "0.0.0-fake" },
    });
    expect(await readdir(layout.scratchDir)).toEqual([]);
  });

  it("refuses a Node runtime that cannot accept Inspector signal hardening", async () => {
    const unsupported = join(tmp, "unsupported-node");
    await writeFile(unsupported, `#!/bin/sh
if [ "\${1:-}" = --disable-sigusr1 ]; then exit 9; fi
exec ${shq(process.execPath)} "$@"
`, { mode: 0o755 });
    const envFile = join(app, "env");
    const original = await readFile(envFile, "utf8");
    await writeFile(envFile, original.replace(`RESEARCHER_NODE=${process.execPath}\n`, `RESEARCHER_NODE=${unsupported}\n`));
    chmodRepos("a-w");
    try {
      const res = await bash(join(app, "verify.sh"), []);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("supporting --disable-sigusr1");
    } finally {
      await writeFile(envFile, original);
      chmodRepos("u+w");
    }
  });

  it("refuses a runner launch that drops Inspector signal hardening", async () => {
    const unprotected = join(tmp, "unprotected-node");
    await writeFile(unprotected, `#!/bin/sh
if [ "\${1:-}" = --disable-sigusr1 ]; then shift; fi
exec ${shq(process.execPath)} "$@"
`, { mode: 0o755 });
    const envFile = join(app, "env");
    const original = await readFile(envFile, "utf8");
    await writeFile(envFile, original.replace(`RESEARCHER_RUNNER_NODE=${process.execPath}\n`, `RESEARCHER_RUNNER_NODE=${unprotected}\n`));
    chmodRepos("a-w");
    try {
      const res = await bash(join(app, "verify.sh"), []);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("runner Inspector protection failed");
    } finally {
      await writeFile(envFile, original);
      chmodRepos("u+w");
    }
  });

  it("refuses a checkout the runner user can write to", async () => {
    const res = await bash(join(app, "verify.sh"), []);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("is writable by");
  });
});

describe("run-investigation.sh", { timeout: 30_000 }, () => {
  it("prevents a same-user subprocess from activating the runner debugger", async () => {
    const runDir = join(tmp, "runs/run-inspector");
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await writeFile(join(runDir, "input.json"), JSON.stringify(runnerInput(layout, "inspector-probe")));

    const res = await bash(join(app, "run-investigation.sh"), [runDir, "30"]);
    expect(res.code, res.stderr).toBe(0);
    const { events } = parseRunnerEvents(await readFile(`${runDir}.jsonl`, "utf8"));
    expect(runnerReport(events)).toMatchObject({ inspectorActive: false });
  });

  it("runs the runner without orchestration secrets, deletes the key, and leaves events and exit status beside the run dir", async () => {
    const runDir = join(tmp, "runs/run-abc");
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await writeFile(join(runDir, "input.json"), JSON.stringify(runnerInput(layout)));
    await writeFile(join(runDir, "key"), "sk-ant-script-key");

    const res = await bash(join(app, "run-investigation.sh"), [runDir, "30"]);

    expect(res.code).toBe(0);
    expect(await readFile(`${runDir}.exit`, "utf8")).toBe("0\n");
    const { events } = parseRunnerEvents(await readFile(`${runDir}.jsonl`, "utf8"));
    expect(events.map((e) => e.type)).toEqual(["started", "assistant_text", "result"]);
    const report = runnerReport(events);
    expect(report).toMatchObject({ key: "sk-ant-script-key", keyInEnv: false });
    expect(report.cwd).toContain(layout.scratchDir);
    expect(report.envKeys).not.toContain("DATABASE_URL");
    expect(existsSync(join(runDir, "key"))).toBe(false);
  });
});

describe("scrub-credentials.sh", { timeout: 30_000 }, () => {
  it("fails without printing the token while one is in a repo's .git, and deletes the staged credentials once none is", async () => {
    const token = "ghp_scrubTestToken0000000000000000000";
    const creds = await mkdtemp(join(tmp, "creds-"));
    await writeFile(join(creds, "github.com"), `x-access-token\n${token}`);
    const scrub = join(SANDBOX, "build/scrub-credentials.sh");

    await git(["-C", repo, "config", "remote.origin.pushurl", `https://x:${token}@github.com/acme/widget.git`]);
    let leaked: Awaited<ReturnType<typeof bash>>;
    try {
      leaked = await bash(scrub, [creds, layout.reposRoot]);
    } finally {
      await git(["-C", repo, "config", "--unset", "remote.origin.pushurl"]);
    }
    expect(leaked.code).toBe(1);
    expect(leaked.stderr).toContain("token for github.com found in");
    expect(leaked.stderr).not.toContain(token);
    expect(existsSync(creds)).toBe(true);

    const clean = await bash(scrub, [creds, layout.reposRoot]);
    expect(clean).toMatchObject({ code: 0, stderr: "" });
    expect(existsSync(creds)).toBe(false);
  });
});
