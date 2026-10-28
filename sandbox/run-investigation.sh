#!/usr/bin/env bash
# Runs one investigation as the runner user, bounded by coreutils timeout.
# Usage: run-investigation.sh <run_dir> <timeout_seconds>
# <run_dir> holds input.json (fed on stdin) and optionally `key`, the model API key: the runner deletes it on
# read, and this script deletes it on exit regardless. Exits with the runner's status, or 124/137 on timeout.
# The runner's events (JSONL) go to <run_dir>.jsonl and the exit status to <run_dir>.exit, which the host
# downloads. They sit beside <run_dir> rather than in it: <run_dir> is handed to the runner user, while these
# stay root-owned in sticky /tmp, so the agent cannot rewrite them.
set -euo pipefail

run_dir=$1 seconds=$2
app=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=/dev/null
. "$app/env"

key="$run_dir/key"
args=()
if [ -f "$key" ]; then args=(--key-file "$key"); fi
if [ "$(id -u)" = 0 ] && [ "$RESEARCHER_RUN_AS" != root ]; then chown -R "$RESEARCHER_RUN_AS": "$run_dir"; fi

status=0
timeout --kill-after=10s "$seconds" "$app/as-runner.sh" --node "$RESEARCHER_APP_DIR/runner/runner.mjs" ${args[@]+"${args[@]}"} \
  <"$run_dir/input.json" >"$run_dir.jsonl" || status=$?
rm -f "$key"
echo "$status" >"$run_dir.exit"
exit "$status"
