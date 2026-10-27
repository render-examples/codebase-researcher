#!/usr/bin/env bash
# Git credential helper for the builder's clone step. Answers `get` from <creds_dir>/<host>, a file holding
# the username on line 1 and the token on line 2. The token never appears in argv, a URL, or git config.
# Usage (git appends the action): git -c credential.helper='!bash git-credential-staged.sh <creds_dir> <node_path>' clone ...
set -euo pipefail

creds_dir=$1
node=${2:-}
action=${3:-}
[ "$action" = get ] || exit 0

protocol="" host=""
while IFS= read -r line; do
  case "$line" in
    protocol=*) protocol=${line#protocol=} ;;
    host=*) host=${line#host=} ;;
  esac
done
[ "$protocol" = https ] && [ -n "$node" ] || exit 0
# Match the trusted host's WHATWG URL normalization, including default/numeric ports and IPv4 aliases.
# The input and Node path are non-secret; credentials stay in the file and credential-protocol output.
host=$("$node" -e '
  const raw = process.argv[1];
  try {
    if (!raw || /[\s/\\@?#]/.test(raw) || raw.startsWith(".")) process.exit(1);
    const host = new URL("https://" + raw).host;
    if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/.test(host) || host.startsWith(".")) process.exit(1);
    process.stdout.write(host);
  } catch { process.exit(1); }
' -- "$host") || exit 0

file="$creds_dir/$host"
[ -s "$file" ] || exit 0
# The file is written without a trailing newline, so the last read returns non-zero after filling `token`.
{ IFS= read -r username && { IFS= read -r token || [ -n "$token" ]; }; } <"$file"
printf 'username=%s\npassword=%s\n' "$username" "$token"
