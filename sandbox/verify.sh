#!/usr/bin/env bash
# Verifies a prepared sandbox: the builder before it is snapshotted, and every sandbox restored from the snapshot.
# Prints one JSON line describing the sandbox (runner user, Pi/prompt versions, runner dumpability, DNS).
# Usage: verify.sh [--deny-probe URL] [--allow-probe URL]   (egress probes run as the runner user)
set -euo pipefail

app=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=/dev/null
. "$app/env"
fail() { printf 'verify: %s\n' "$*" >&2; exit 1; }
as_runner() { "$app/as-runner.sh" "$@"; }

deny_probe="" allow_probe=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deny-probe) deny_probe=$2; shift 2 ;;
    --allow-probe) allow_probe=$2; shift 2 ;;
    *) fail "unknown argument $1" ;;
  esac
done

# ── Tools ─────────────────────────────────────────────────────────────────

for tool in git rg timeout; do PATH="$RESEARCHER_PATH" command -v "$tool" >/dev/null || fail "missing $tool"; done
node_version=$("$RESEARCHER_NODE" --disable-sigusr1 -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
console.log(process.versions.node);
') || fail "need Node >= 22.19 supporting --disable-sigusr1"

# ── Credential hygiene ────────────────────────────────────────────────────
# No stored credentials or credential helpers should survive into the snapshot.

[ ! -e "$HOME/.git-credentials" ] || fail "$HOME/.git-credentials exists"
pattern='^(credential\.|url\..*\.insteadof|http\..*\.extraheader)'
for scope in --system --global; do
  if git config "$scope" --get-regexp "$pattern" >/dev/null 2>&1; then fail "credential settings in git $scope config"; fi
done
repos=$(find "$RESEARCHER_REPOS_ROOT" -mindepth 3 -maxdepth 3 -name .git -type d -exec dirname {} \;)
[ -n "$repos" ] || fail "no repos under $RESEARCHER_REPOS_ROOT"
while IFS= read -r r; do
  if git -c safe.directory='*' -C "$r" config --local --get-regexp "$pattern" >/dev/null 2>&1; then fail "$r: credential settings in .git/config"; fi
  url=$(git -c safe.directory='*' -C "$r" config --local --get remote.origin.url || true)
  case "$url" in *@*) fail "$r: remote URL carries credentials" ;; esac
done <<<"$repos"

# ── Manifest and repo integrity ──────────────────────────────────────────

entries=$("$RESEARCHER_NODE" -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const r of m.repos) console.log([r.commit, r.path, r.repository].join("\t"));
' "$app/manifest.json") || fail "cannot read manifest"
[ -n "$entries" ] || fail "manifest lists no repos"
g() { GIT_OPTIONAL_LOCKS=0 git -c safe.directory='*' -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$path" "$@"; }
while IFS=$'\t' read -r commit path repo; do
  head=$(g rev-parse HEAD 2>&1) || fail "$repo: $head"
  [ "$head" = "$commit" ] || fail "$repo: HEAD $head != manifest $commit"
  dirty=$(g status --porcelain --ignored 2>&1) || fail "$repo: git status failed: $dirty"
  [ -z "$dirty" ] || fail "$repo: working tree modified"
done <<<"$entries"

# ── Runner self-test ─────────────────────────────────────────────────────

self_test=$(as_runner --node "$app/runner/runner.mjs" --self-test) || fail "runner self-test failed"

# ── Inspector check ──────────────────────────────────────────────────────
# Non-dumpability does not stop a same-uid tool process from signaling Node to start its debugger.

as_runner --node -e '
const { spawnSync } = require("node:child_process");
const inspector = require("node:inspector");
if (!process.execArgv.includes("--disable-sigusr1")) throw new Error("runner lacks Inspector signal hardening");
process.debugPort = 0;
const signal = spawnSync(process.execPath, ["-e", "process.kill(Number(process.argv[1]), \"SIGUSR1\")", String(process.pid)], { timeout: 2000 });
if (signal.status !== 0) throw new Error("same-user signal probe failed");
setTimeout(() => {
  const active = inspector.url() !== undefined;
  inspector.close();
  if (active) { console.error("runner Inspector activated"); process.exitCode = 1; }
}, 100);
' || fail "runner Inspector protection failed"

# ── Non-dumpable check ───────────────────────────────────────────────────
# An execute-only runner node keeps its memory (the model key) from same-uid tool subprocesses via /proc.

non_dumpable=false
if [ "$(id -u)" = 0 ] && [ "$RESEARCHER_RUN_AS" != root ]; then
  pidfile="$RESEARCHER_SCRATCH_DIR/.researcher-dumpable-probe.pid"
  rm -f "$pidfile"
  as_runner --node -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)' "$pidfile" &
  launcher=$!
  for _ in $(seq 1 100); do [ -s "$pidfile" ] && break; sleep 0.2; done
  pid=$(cat "$pidfile" 2>/dev/null) || fail "$RESEARCHER_RUNNER_NODE did not start"
  stop_probe() { kill "$pid" 2>/dev/null || true; wait "$launcher" 2>/dev/null || true; }
  if err=$(as_runner cat "/proc/$pid/maps" 2>&1 >/dev/null); then
    stop_probe
    fail "runner is dumpable: $RESEARCHER_RUN_AS can read /proc/$pid/maps of $RESEARCHER_RUNNER_NODE"
  fi
  stop_probe
  case "$err" in *"Permission denied"*) non_dumpable=true ;; *) fail "dumpability probe inconclusive: $err" ;; esac
fi

# ── DNS and permissions ──────────────────────────────────────────────────

dns_resolves=false
if timeout 10 "$app/as-runner.sh" getent hosts example.com >/dev/null 2>&1; then dns_resolves=true; fi

repo=$(find "$RESEARCHER_REPOS_ROOT" -mindepth 2 -maxdepth 2 -type d | head -n 1)
[ -n "$repo" ] || fail "no repos under $RESEARCHER_REPOS_ROOT"
if as_runner touch "$repo/.researcher-write-probe" 2>/dev/null; then
  rm -f "$repo/.researcher-write-probe"
  fail "$repo is writable by $RESEARCHER_RUN_AS"
fi
as_runner touch "$RESEARCHER_SCRATCH_DIR/.researcher-write-probe" || fail "scratch is not writable by $RESEARCHER_RUN_AS"

# ── Egress probes ────────────────────────────────────────────────────────

probe='fetch(process.argv[1], { redirect: "manual", signal: AbortSignal.timeout(8000) }).then(() => process.exit(0), () => process.exit(1))'
if [ -n "$deny_probe" ] && as_runner "$RESEARCHER_NODE" -e "$probe" "$deny_probe"; then fail "egress to $deny_probe is allowed"; fi
if [ -n "$allow_probe" ] && ! as_runner "$RESEARCHER_NODE" -e "$probe" "$allow_probe"; then fail "egress to $allow_probe is blocked"; fi

# ── Cleanup and report ───────────────────────────────────────────────────

find "$RESEARCHER_SCRATCH_DIR" -mindepth 1 -delete

"$RESEARCHER_NODE" -e '
const [runAs, uid, drop, selfTest, nonDumpable, dnsResolves] = process.argv.slice(1);
console.log(JSON.stringify({
  runAs, uid: Number(uid), drop, node: process.version,
  runnerNonDumpable: nonDumpable === "true", dnsResolves: dnsResolves === "true",
  selfTest: JSON.parse(selfTest.trim().split("\n").pop()),
}));
' "$RESEARCHER_RUN_AS" "$(id -u)" "$RESEARCHER_DROP" "$self_test" "$non_dumpable" "$dns_resolves"
