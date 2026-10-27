import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHeads } from "../src/sandbox/render/snapshot.ts";
import { loadRenderConfig } from "../src/sandbox/render/config.ts";
import { defineConfig, HostCredentials } from "../src/bot-config.ts";
import config from "../config.ts";
import { shq } from "../src/sandbox/interface.ts";

const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const STAGED_HELPER = fileURLToPath(new URL("../sandbox/build/git-credential-staged.sh", import.meta.url));
const COMMIT = "a".repeat(40);
const ORIGINAL_CREDENTIALS = config.gitCredentials;
let root: string;
let credentialsDir: string;
let recordFile: string;
let configFile: string;

type Credential = { username: string; token: string };
type GitRecord = { args: string[]; url: string; credential: { username?: string; password?: string }; tokenEnvNames: string[] };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "git-credential-selection-"));
  credentialsDir = join(root, "creds");
  recordFile = join(root, "record.json");
  configFile = join(root, "gitconfig");
  const shim = join(root, "bin");
  await mkdir(credentialsDir);
  await mkdir(shim);
  await writeFile(configFile, "");
  // Stand in for remote access, but run real Git credential fill with the exact -c helper arguments.
  await writeFile(join(shim, "git"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const index = args.indexOf("ls-remote");
const url = args[index + 1] === "--symref" ? args[index + 2] : args[index + 1];
const result = spawnSync(process.env.RESEARCHER_TEST_REAL_GIT, [...args.slice(0, index), "credential", "fill"], {
  input: "url=" + url + "\\n\\n", encoding: "utf8", env: process.env,
});
const credential = Object.fromEntries(result.stdout.trim().split("\\n").filter(Boolean).map((line) => {
  const equal = line.indexOf("="); return [line.slice(0, equal), line.slice(equal + 1)];
}));
writeFileSync(process.env.RESEARCHER_TEST_RECORD, JSON.stringify({ args, url, credential,
  tokenEnvNames: Object.keys(process.env).filter((name) => name.startsWith("RESEARCHER_TOKEN_")),
}));
if (process.env.RESEARCHER_TEST_GIT_FAIL) { process.stderr.write("synthetic Git failure"); process.exit(1); }
process.stdout.write("ref: refs/heads/main\\tHEAD\\n${COMMIT}\\tHEAD\\n");
`, { mode: 0o755 });
  vi.stubEnv("PATH", `${shim}:${process.env.PATH}`);
  vi.stubEnv("HOME", root);
  vi.stubEnv("GIT_CONFIG_GLOBAL", configFile);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
  vi.stubEnv("GIT_ASKPASS", "/usr/bin/false");
  vi.stubEnv("SSH_ASKPASS", "/usr/bin/false");
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  vi.stubEnv("RESEARCHER_TEST_REAL_GIT", REAL_GIT);
  vi.stubEnv("RESEARCHER_TEST_RECORD", recordFile);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  config.gitCredentials = ORIGINAL_CREDENTIALS;
  await rm(root, { recursive: true, force: true });
});

function stagedCredential(url: string) {
  const helper = `credential.helper=!bash ${shq(STAGED_HELPER)} ${shq(credentialsDir)} ${shq(process.execPath)}`;
  const args = ["-c", "credential.helper=", "-c", helper, "credential", "fill"];
  const result = spawnSync(REAL_GIT, args, { input: `url=${url}\n\n`, env: process.env, encoding: "utf8" });
  const credential = Object.fromEntries(result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const equal = line.indexOf("=");
    return [line.slice(0, equal), line.slice(equal + 1)];
  }));
  return { ...result, credential, args };
}

async function compareSelection(url: string, credentials: { [host: string]: Credential }) {
  for (const [host, credential] of Object.entries(credentials)) {
    await writeFile(join(credentialsDir, host), `${credential.username}\n${credential.token}`, { mode: 0o600 });
  }
  const heads = await resolveHeads({ name: "test", repos: [{ repository: "acme/repo", url }] }, credentials);
  const resolution = JSON.parse(await readFile(recordFile, "utf8")) as GitRecord;
  return { heads, resolution, staged: stagedCredential(url) };
}

describe("HTTPS Git credential selection", () => {
  it("uses the same port-specific credential for head resolution and cloning", async () => {
    const specific = { username: "port-user", token: "synthetic-port-token" };
    const defaultPort = { username: "default-user", token: "synthetic-default-token" };
    const { resolution, staged } = await compareSelection("https://git.example:8443/acme/repo.git", {
      "git.example": defaultPort,
      "git.example:8443": specific,
    });

    expect(resolution.credential.password).toBe(specific.token);
    expect(staged.credential.password).toBe(specific.token);
    expect(resolution.tokenEnvNames).toContain("RESEARCHER_TOKEN_GIT_EXAMPLE_8443");
  });

  it.each([
    { key: "github.com", urlHost: "github.com", normalized: "github.com" },
    { key: "git.example", urlHost: "git.example:443", normalized: "git.example" },
    { key: "git.example:443", urlHost: "git.example", normalized: "git.example" },
    { key: "git.example:0443", urlHost: "git.example:0443", normalized: "git.example" },
    { key: "GIT.EXAMPLE:8443", urlHost: "GIT.EXAMPLE:8443", normalized: "git.example:8443" },
    { key: "git.example:08443", urlHost: "git.example:08443", normalized: "git.example:8443" },
    { key: "127.1:443", urlHost: "127.1:0443", normalized: "127.0.0.1" },
  ])("normalizes configured $key consistently with Git's raw $urlHost", async ({ key, urlHost, normalized }) => {
    const token = "synthetic-selected-token";
    config.gitCredentials = { [key]: { username: "test-user", tokenEnv: "SYNTHETIC_GIT_TOKEN" } };
    const loaded = await loadRenderConfig({
      RENDER_API_KEY: "synthetic-render-key", RENDER_WORKSPACE_ID: "tea-test", SYNTHETIC_GIT_TOKEN: token,
    });
    expect(Object.keys(loaded.hostCredentials)).toEqual([normalized]);
    const url = `https://${urlHost}/acme/repo.git`;

    const { heads, resolution, staged } = await compareSelection(url, loaded.hostCredentials);

    expect(heads[0]).toMatchObject({ commit: COMMIT, url });
    expect(resolution.credential).toMatchObject({ username: "test-user", password: token });
    expect(staged.status).toBe(0);
    expect(staged.credential).toMatchObject({ username: "test-user", password: token });
    expect(JSON.stringify([resolution.args, resolution.url, staged.args, staged.stderr])).not.toContain(token);
    expect(await readFile(configFile, "utf8")).toBe("");
  });

  it.each(["git.example", "git.example:8444"])("does not reuse a credential from %s for port 8443", async (otherHost) => {
    const token = "synthetic-other-origin-token";
    const { resolution, staged } = await compareSelection("https://git.example:8443/acme/repo.git", {
      [otherHost]: { username: "other-user", token },
    });

    expect(resolution.credential.password).toBeUndefined();
    expect(staged.status).not.toBe(0);
    expect(staged.credential.password).toBeUndefined();
    expect(JSON.stringify([resolution.args, resolution.url, staged.args, staged.stderr])).not.toContain(token);
  });

  it.each([
    ["git.example", "git.example:443"],
    ["git.example:443", "git.example:0443"],
    ["git.example:8443", "GIT.EXAMPLE:08443"],
    ["127.1", "127.0.0.1"],
  ])("rejects ambiguous configured identities %s and %s before selecting a token", async (left, right) => {
    const credentials = {
      [left]: { username: "first-user", tokenEnv: "FIRST_TOKEN" },
      [right]: { username: "second-user", tokenEnv: "SECOND_TOKEN" },
    };
    expect(() => HostCredentials.parse(credentials)).toThrow(/duplicates normalized HTTPS credential host/);
    expect(() => defineConfig({ name: "test", repos: [{ repository: "acme/repo" }], gitCredentials: credentials }, {})).toThrow(/duplicates normalized HTTPS credential host/);
    config.gitCredentials = credentials;
    await expect(loadRenderConfig({
      RENDER_API_KEY: "synthetic-render-key", RENDER_WORKSPACE_ID: "tea-test", FIRST_TOKEN: "synthetic-first", SECOND_TOKEN: "synthetic-second",
    })).rejects.toThrow(/duplicates normalized HTTPS credential host/);
  });

  it("rejects an invalid configured HTTPS port", () => {
    expect(() => HostCredentials.parse({ "git.example:99999": { username: "test-user", tokenEnv: "TEST_TOKEN" } })).toThrow(/valid HTTPS credential host and port/);
  });

  it("keeps synthetic token values out of resolution errors and Git configuration", async () => {
    const token = "synthetic-error-path-token";
    vi.stubEnv("RESEARCHER_TEST_GIT_FAIL", "1");
    const error = await resolveHeads({ name: "test", repos: [{ repository: "acme/repo", url: "https://git.example:8443/acme/repo.git" }] }, {
      "git.example:8443": { username: "test-user", token },
    }).catch((err: unknown) => err);
    const record = JSON.parse(await readFile(recordFile, "utf8")) as GitRecord;

    expect(error).toMatchObject({ message: "git ls-remote acme/repo: synthetic Git failure" });
    expect((error as Error).message).not.toContain(token);
    expect(JSON.stringify(record.args)).not.toContain(token);
    expect(await readFile(configFile, "utf8")).toBe("");
  });
});
