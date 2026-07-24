#!/bin/sh
# Materialize the compose-local database URLs into .env. For every KEY=value in .env.compose that
# .env does not already define (as an active, uncommented KEY= line), append it under a
# "# from .env.compose" marker so a later run can tell these lines from the developer's own.
# Idempotent, and a key the developer already set — even to a different value — is never clobbered.
#
#   make env         # run this
#   make bootstrap   # runs this first, then brings the stack up and migrates
set -eu

# Repo root, so .env / .env.compose resolve regardless of caller cwd.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

SRC=.env.compose
DEST=.env

[ -f "$SRC" ] || { echo "env-merge: $SRC not found" >&2; exit 1; }
[ -f "$DEST" ] || : >"$DEST" # a fresh checkout has no .env yet

missing=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '' | \#*) continue ;; # skip blanks and comment lines
  esac
  key=${line%%=*}
  if grep -q "^[[:space:]]*${key}=" "$DEST"; then
    continue
  fi
  missing="${missing}${line}
"
done <"$SRC"

if [ -z "$missing" ]; then
  echo "env-merge: .env already defines every compose-local key — nothing to append"
  exit 0
fi

{
  printf '\n# from .env.compose\n'
  printf '%s' "$missing"
} >>"$DEST"

echo "env-merge: appended compose-local keys to .env:"
printf '%s' "$missing" | sed 's/^/  /'
