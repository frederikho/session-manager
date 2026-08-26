#!/usr/bin/env bash
# Mirror another machine's Claude and Codex transcripts into remote/<host>/ so the
# session manager can list and search them alongside the local ones.
#
#   bin/pull-remote.sh solar-panels-h
#
# The mirror is read-only: the tool refuses to restore into it, and --delete means
# a session removed upstream disappears here too.
set -euo pipefail

host=${1:-}
if [ -z "$host" ]; then
  echo "usage: $(basename "$0") <ssh-host> [more-hosts...]" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for host in "$@"; do
  dest="$root/remote/$host"
  mkdir -p "$dest/claude" "$dest/codex"

  echo "→ $host: Claude transcripts"
  rsync -az --delete --prune-empty-dirs \
    --include='*/' --include='*.jsonl' --exclude='*' \
    "$host:.claude/projects/" "$dest/claude/"

  echo "→ $host: Codex transcripts"
  rsync -az --delete --prune-empty-dirs \
    --include='*/' --include='*.jsonl' --exclude='*' \
    "$host:.codex/sessions/" "$dest/codex/"

  echo "✓ $host mirrored into remote/$host"
done
