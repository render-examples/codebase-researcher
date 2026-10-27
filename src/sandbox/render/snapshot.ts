import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import type { SandboxSnapshot } from "@renderinc/sdk/experimental";
import { create as createTar } from "tar";
import type { RepoManifest, RepoProfile } from "../../manifest.ts";
import { errorMessage } from "../../util.ts";
import { git, shq } from "../interface.ts";
import { bundleRunner } from "../runner-bundle.ts";
import type { SandboxApi, SandboxClient } from "./client.ts";
import type { RenderConfig } from "./config.ts";
import { SANDBOX_APP, SANDBOX_REPOS, SANDBOX_ROOT, SANDBOX_RUN_AS, SANDBOX_SCRATCH, verifySandbox } from "./sandbox.ts";

export type BuiltSnapshot = { id: string; sandboxGroupId: string };

/** Resolves heads, builds a snapshot from them, and prunes older snapshots with the same name. */
export async function rebuildSnapshot(
  client: SandboxClient,
  opts: { profile: RepoProfile; snapshotName: string; keep: number },
): Promise<{ id: string; repos: number }> {
  const heads = await resolveHeads(opts.profile, client.cfg.hostCredentials);
  const built = await buildSnapshot(client, { profile: opts.profile, heads, snapshotName: opts.snapshotName });
  await pruneSnapshots(client, built, opts.snapshotName, opts.keep);
  return { id: built.id, repos: heads.length };
}

/** Resolves the current default-branch (or configured branch) commit of each repo with `git ls-remote`. */
export async function resolveHeads(profile: RepoProfile, hostCreds: RenderConfig["hostCredentials"]): Promise<RepoManifest["repos"]> {
  return Promise.all(
    profile.repos.map(async ({ repository, branch, url: repoUrl, browse }) => {
      const url = repoUrl ?? `https://github.com/${repository}.git`;
      const host = new URL(url).hostname;
      const cred = hostCreds[host];
      // The token reaches git only through the environment of this trusted process, never argv or a URL.
      const envVar = `RESEARCHER_TOKEN_${host.replace(/\W/g, "_").toUpperCase()}`;
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(cred ? { [envVar]: cred.token } : {}) };
      const auth = ["-c", "credential.helper=", ...(cred ? ["-c", hostTokenHelper(cred.username, envVar)] : [])];
      const args = branch ? ["ls-remote", url, `refs/heads/${branch}`] : ["ls-remote", "--symref", url, "HEAD"];
      let out: string;
      try {
        out = await git([...auth, ...args], { env });
      } catch (err) {
        throw new Error(`git ls-remote ${repository}: ${errorMessage(err)}`);
      }
      const head = parseLsRemote(out, branch);
      if (!head) throw new Error(`git ls-remote ${repository}: no ${branch ? `branch ${branch}` : "default branch"} in output`);
      return { repository, ...head, path: repository, ...(repoUrl && { url: repoUrl }), ...(browse && { browse }) };
    }),
  );
}

/** Builds a git credential helper for a specific host's username and token env var. */
function hostTokenHelper(username: string, envVar: string): string {
  return `credential.helper=!f() { test "$1" = get || return 0; printf 'username=${username}\\npassword=%s\\n' "$${envVar}"; }; f`;
}

/** `ls-remote --symref <url> HEAD` or `ls-remote <url> refs/heads/<branch>` → branch + commit. */
export function parseLsRemote(out: string, branch?: string): { branch: string; commit: string } | null {
  let resolved = branch;
  let commit: string | undefined;
  for (const line of out.split("\n")) {
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (sym) {
      resolved ??= sym[1];
      continue;
    }
    const ref = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
    if (ref && ref[2] === (branch ? `refs/heads/${branch}` : "HEAD")) commit = ref[1];
  }
  return resolved && commit ? { branch: resolved, commit } : null;
}

const STAGE = "/tmp/researcher-stage";
const STAGE_CREDS = `${STAGE}/creds`;
const SAFE_REF = /^\w[\w./-]*$/;
const SAFE_NAME = /^[\w.-]+$/;
const SANDBOX_GITCONFIG = `[safe]\n\tdirectory = *\n[core]\n\tfsmonitor = false\n[gc]\n\tauto = 0\n`;

/** Copied into the app dir and kept in the snapshot. */
export const RUNTIME_SCRIPTS = ["install-tools.sh", "as-runner.sh", "run-investigation.sh", "verify.sh"] as const;
/** Builder-only: they stay in the staging dir, which is deleted before the snapshot. */
export const BUILD_SCRIPTS = ["build/git-credential-staged.sh", "build/scrub-credentials.sh"] as const;

/**
 * Builds one named snapshot containing the runner and exactly these repository heads. Each step is a
 * direct Sandbox API call (exec / upload) in an allow-all builder sandbox:
 *
 *   1. Upload sandbox/ and the runner bundle to a staging dir
 *   2. Install tools (git, node, ripgrep) via install-tools.sh
 *   3. Detect node path and privilege-drop tool, create runner user, write env
 *   4. Set permissions, run the runner's self-test
 *   5. Upload per-host credentials, clone each repo, scrub credentials (build/ scripts)
 *   6. Upload the manifest
 *   7. Lockdown (chown root, chmod read-only, execute-only node), delete the staging dir
 *   8. verify.sh, then snapshot
 */
export async function buildSnapshot(
  client: SandboxClient,
  { profile, heads, snapshotName }: { profile: RepoProfile; heads: RepoManifest["repos"]; snapshotName: string },
): Promise<BuiltSnapshot> {
  if (!SAFE_NAME.test(snapshotName)) throw new Error(`snapshot name ${JSON.stringify(snapshotName)} is not [A-Za-z0-9_.-]+`);
  for (const h of heads) {
    if (!SAFE_REF.test(h.branch)) throw new Error(`${h.repository}: unsupported branch name ${JSON.stringify(h.branch)}`);
  }
  const t = client.t;
  const prepare = { timeoutMs: t.prepareTimeoutMs };
  const boot = { timeoutMs: t.bootTimeoutMs };
  const { id } = await client.create(
    { timeoutSeconds: client.cfg.builderTimeoutSeconds, networkPolicy: { type: "allow-all" } },
    { timeoutMs: t.bootTimeoutMs },
  );
  try {
    await client.waitRunning(id);

    await client.check(id, `mkdir -p -m 700 ${STAGE}`, { ...boot, waitReady: true });
    // Uploaded as an opaque .tgz and extracted in the sandbox: the upload endpoint rejects an
    // uncompressed tar of the bundled runner's JavaScript, and doesn't accept application/gzip.
    await client.upload(id, `${STAGE}/stage.tgz`, await stageArchive(client.cfg));
    await client.check(id, `tar -xzf ${STAGE}/stage.tgz -C ${STAGE} && rm ${STAGE}/stage.tgz`, boot);

    await client.check(id,
      `mkdir -p ${SANDBOX_APP}/runner ${SANDBOX_REPOS} ${SANDBOX_SCRATCH}` +
      ` && cp ${STAGE}/*.sh ${SANDBOX_APP}/` +
      ` && cp -R ${STAGE}/runner ${SANDBOX_APP}/`,
      boot,
    );
    await client.check(id, `bash ${SANDBOX_APP}/install-tools.sh ${SANDBOX_APP}`, prepare);
    const env = await detectEnv(client, id);
    await client.check(id, createRunnerUserCommand(), boot);
    await client.upload(id, `${SANDBOX_APP}/env`, envFileContent(env.nodePath, env.dropTool));
    await client.upload(id, `${SANDBOX_APP}/gitconfig`, SANDBOX_GITCONFIG);

    // The self-test executes third-party code (the bundled packages); credentials are
    // uploaded only after this step succeeds.
    await client.check(id, [
      `chmod 755 ${SANDBOX_ROOT}`,
      `chmod -R a+rX,go-w ${SANDBOX_APP}`,
      `timeout 120 ${SANDBOX_APP}/as-runner.sh ${shq(env.nodePath)} ${SANDBOX_APP}/runner/runner.mjs --self-test`,
    ].join(" && "), prepare);

    for (const [host, { username, token }] of Object.entries(client.cfg.hostCredentials)) {
      await client.upload(id, `${STAGE_CREDS}/${host}`, `${username}\n${token}`);
    }
    for (const h of heads) {
      const url = h.url ?? `https://github.com/${h.repository}.git`;
      if (!/^https:\/\//.test(url)) throw new Error(`${h.repository}: only https:// clone URLs are supported`);
      await client.check(id, cloneCommand(h, url), prepare);
    }
    const scrub = await client.exec(id, `bash ${STAGE}/build/scrub-credentials.sh ${STAGE_CREDS} ${SANDBOX_REPOS}`, prepare);
    if (scrub.exitCode !== 0) throw new Error(`credential scrub failed: ${(scrub.stderr || scrub.stdout).trim().slice(-2000)}`);

    const manifest: RepoManifest = {
      profile: profile.name,
      created_at: new Date().toISOString(),
      repos: heads.map((h) => ({ ...h, path: `${SANDBOX_REPOS}/${h.repository}` })),
    };
    await client.upload(id, `${SANDBOX_APP}/manifest.json`, JSON.stringify(manifest, null, 2));
    await client.check(id, lockdownCommand(env.nodePath), prepare);
    await client.check(id, `rm -rf ${STAGE}`, prepare);
    const info = await verifySandbox(client, id);
    if (!info.runnerNonDumpable) throw new Error(`could not confirm the runner is non-dumpable in builder ${id}; every restore would refuse this snapshot`);

    const snap = await createSnapshot(client, id, snapshotName);
    return { id: snap.id, sandboxGroupId: snap.sandboxGroupId };
  } finally {
    await client.terminateQuietly(id);
  }
}

/** Detects the node binary path and the available privilege-drop tool inside the sandbox. */
async function detectEnv(client: SandboxClient, id: string): Promise<{ nodePath: string; dropTool: string }> {
  const res = await client.exec(id, [
    `node=$([ -x ${SANDBOX_APP}/node/bin/node ] && echo ${SANDBOX_APP}/node/bin/node || which node)`,
    `drop=none; for t in setpriv runuser su; do command -v "$t" >/dev/null 2>&1 && drop=$t && break; done`,
    'printf "%s\\n%s\\n" "$node" "$drop"',
  ].join(" && "), { timeoutMs: client.t.bootTimeoutMs });
  if (res.exitCode !== 0) throw new Error(`environment detection failed: ${res.stderr.trim()}`);
  const [nodePath, dropTool] = res.stdout.trim().split("\n");
  if (!nodePath) throw new Error("environment detection returned no node path");
  return { nodePath, dropTool: dropTool ?? "none" };
}

/** Creates the unprivileged runner user (useradd or adduser, depending on the distro). */
function createRunnerUserCommand(): string {
  return (
    `id -u ${SANDBOX_RUN_AS} >/dev/null 2>&1` +
    ` || { command -v useradd >/dev/null && useradd --system --user-group --no-create-home` +
    ` --home-dir ${SANDBOX_SCRATCH}/home --shell /usr/sbin/nologin ${SANDBOX_RUN_AS}; }` +
    ` || { addgroup -S ${SANDBOX_RUN_AS} && adduser -S -D -H -h ${SANDBOX_SCRATCH}/home -s /sbin/nologin -G ${SANDBOX_RUN_AS} ${SANDBOX_RUN_AS}; }`
  );
}

/** The env file that as-runner.sh and verify.sh source at runtime. */
function envFileContent(nodePath: string, dropTool: string): string {
  const nodeDir = nodePath.substring(0, nodePath.lastIndexOf("/"));
  return [
    `RESEARCHER_ROOT=${SANDBOX_ROOT}`,
    `RESEARCHER_APP_DIR=${SANDBOX_APP}`,
    `RESEARCHER_REPOS_ROOT=${SANDBOX_REPOS}`,
    `RESEARCHER_SCRATCH_DIR=${SANDBOX_SCRATCH}`,
    `RESEARCHER_RUN_AS=${SANDBOX_RUN_AS}`,
    `RESEARCHER_DROP=${dropTool}`,
    `RESEARCHER_NODE=${nodePath}`,
    `RESEARCHER_RUNNER_NODE=${SANDBOX_APP}/node-runner`,
    `RESEARCHER_PATH=${SANDBOX_APP}/bin:${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  ].join("\n") + "\n";
}

/** The git clone + configure + detach command for one repository. */
function cloneCommand(h: { repository: string; branch: string; commit: string }, url: string): string {
  const dest = `${SANDBOX_REPOS}/${h.repository}`;
  const credHelper = `credential.helper=!bash ${STAGE}/build/git-credential-staged.sh ${STAGE_CREDS}`;
  return [
    `mkdir -p $(dirname ${shq(dest)})`,
    `GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c ${shq(credHelper)} clone --quiet --single-branch --branch ${shq(h.branch)} --no-tags -- ${shq(url)} ${shq(dest)}`,
    `git -C ${shq(dest)} config core.checkStat minimal`,
    `git -C ${shq(dest)} config core.trustctime false`,
    `git -C ${shq(dest)} config gc.auto 0`,
    `git -C ${shq(dest)} -c advice.detachedHead=false checkout --quiet --detach ${h.commit}`,
    `head=$(git -C ${shq(dest)} rev-parse HEAD) && [ "$head" = ${shq(h.commit)} ]`,
  ].join(" && ");
}

/** Makes repos root-owned and read-only; gives scratch to the runner user; installs execute-only node. */
function lockdownCommand(nodePath: string): string {
  return [
    `chown -R root:root ${SANDBOX_ROOT}`,
    `chmod 755 ${SANDBOX_ROOT}`,
    `chmod -R a+rX,go-w ${SANDBOX_APP}`,
    `chmod -R a+rX,a-w ${SANDBOX_REPOS}`,
    `chown ${SANDBOX_RUN_AS}: ${SANDBOX_SCRATCH}`,
    `chmod 700 ${SANDBOX_SCRATCH}`,
    `install -o root -g root -m 0711 ${shq(nodePath)} ${SANDBOX_APP}/node-runner`,
  ].join(" && ");
}

async function createSnapshot(client: SandboxClient, sandboxId: string, name: string): Promise<SandboxSnapshot> {
  const signal = AbortSignal.timeout(client.t.snapshotTimeoutMs);
  let snap = await client.call(() => client.api.snapshots.create({ sandboxId, kind: "filesystem", name }), { signal });
  const until = Date.now() + client.t.snapshotTimeoutMs;
  while (snap.status === "creating") {
    if (Date.now() > until) throw new Error(`snapshot ${snap.id} still creating after ${client.t.snapshotTimeoutMs}ms`);
    await sleep(client.t.pollMs, undefined, { signal });
    const { id, sandboxGroupId } = snap;
    snap = await client.call(() => client.api.snapshots.get({ sandboxGroupId, snapshotId: id }), { retryOn: [429, 503], signal });
  }
  if (snap.status !== "available") throw new Error(`snapshot ${snap.id} ${snap.status}: ${snap.error ?? "no error given"}`);
  return snap;
}

/** A gzipped tar of the scripts and a freshly built, self-contained runner bundle. */
async function stageArchive({ sandboxDir }: RenderConfig): Promise<Buffer> {
  const bundle = await bundleRunner();
  const dir = await mkdtemp(join(tmpdir(), "researcher-stage-"));
  try {
    await mkdir(join(dir, "runner"));
    await mkdir(join(dir, "build"));
    await writeFile(join(dir, "runner/runner.mjs"), bundle);
    for (const name of [...RUNTIME_SCRIPTS, ...BUILD_SCRIPTS]) await cp(join(sandboxDir, name), join(dir, name));
    const chunks: Buffer[] = [];
    for await (const chunk of createTar({ cwd: dir, portable: true, gzip: true }, await readdir(dir))) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Deletes older available/failed snapshots with this name, keeping the newest `keep`. Logs instead of throwing. */
export async function pruneSnapshots(client: SandboxClient, { sandboxGroupId }: BuiltSnapshot, snapshotName: string, keep: number): Promise<void> {
  try {
    const list: Awaited<ReturnType<SandboxApi["snapshots"]["list"]>> = [];
    for (let cursor: string | undefined; ; ) {
      const page = await client.call(() => client.api.snapshots.list({ sandboxGroupId, status: ["available", "failed"], cursor, limit: 100 }));
      list.push(...page);
      cursor = page.at(-1)?.cursor;
      if (page.length < 100 || !cursor) break;
    }
    const stale = list
      .filter(({ snapshot }) => snapshot.name === snapshotName)
      .sort((a, b) => Date.parse(b.snapshot.requestedAt) - Date.parse(a.snapshot.requestedAt))
      .slice(keep);
    for (const { snapshot } of stale) {
      try {
        await client.call(() => client.api.snapshots.delete({ sandboxGroupId, snapshotId: snapshot.id }));
      } catch (err) {
        if (err instanceof SandboxSnapshotNotFoundError || (err instanceof ClientError && err.statusCode === 404)) continue;
        throw err;
      }
    }
  } catch (err) {
    client.log.warn("snapshot prune failed", { snapshot_name: snapshotName, err });
  }
}
