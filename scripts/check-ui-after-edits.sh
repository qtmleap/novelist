#!/usr/bin/env bash
# Stop hook: takes UI snapshots if src/ has been modified since the last snapshot.
# Stays quiet on the happy path; only emits messages when something interesting
# happens so Claude isn't spammed with no-op output.

set -euo pipefail

cd "$(dirname "$0")/.."

SNAPSHOT_DIR="tests/snapshots"
BASE_URL="${SNAPSHOT_BASE_URL:-http://localhost:11675}"

newest_src_mtime=$(find src -type f \( -name '*.tsx' -o -name '*.ts' -o -name '*.css' \) -printf '%T@\n' 2>/dev/null | sort -nr | head -1)

if [ -z "$newest_src_mtime" ]; then
  exit 0
fi

if [ -d "$SNAPSHOT_DIR" ]; then
  newest_snap_mtime=$(find "$SNAPSHOT_DIR" -type f -name '*.webp' -printf '%T@\n' 2>/dev/null | sort -nr | head -1)
else
  newest_snap_mtime=""
fi

if [ -n "$newest_snap_mtime" ]; then
  is_fresh=$(awk -v a="$newest_snap_mtime" -v b="$newest_src_mtime" 'BEGIN { print (a > b) ? 1 : 0 }')
  if [ "$is_fresh" = "1" ]; then
    exit 0
  fi
fi

if ! curl -sf "$BASE_URL/" -o /dev/null; then
  exit 0
fi

bun run snapshot:ui >/dev/null 2>&1 || exit 0

echo "[ui-checker] src/ changed since last snapshot — fresh shots written to $SNAPSHOT_DIR. Consider invoking the ui-checker agent to review them."
