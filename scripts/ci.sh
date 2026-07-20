#!/bin/sh
# The whole GitHub CI locally, before anything is pushed. Mirrors .github/workflows/ci.yml:
# the check job (check + prop) and the apps job (console verify + budget, docs verify +
# check:ref + build + csp + static). The db matrix needs live engines; DB=1 runs it too.
# Runs every step and summarizes, so one failure does not hide the next.
set -u
REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO"

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || { echo 'ci: node >= 22 required (nvm use 22)'; exit 1; }

FAILED=''
step() {
  name="$1"; shift
  printf '%s' "ci: $name ... "
  if "$@" >/tmp/ci-step.log 2>&1; then
    echo ok
  else
    echo FAIL
    tail -20 /tmp/ci-step.log
    FAILED="$FAILED $name"
  fi
}

step "check"          npm run check
step "prop"           npm run prop
step "console:verify" npm run verify --prefix apps/console
step "console:budget" npm run budget --prefix apps/console
step "docs:verify"    npm run verify --prefix apps/docs
step "docs:check-ref" npm run check:ref --prefix apps/docs
step "docs:build"     npm run build --prefix apps/docs
step "docs:csp"       npm run check:csp --prefix apps/docs
step "docs:static"    npm run check:static --prefix apps/docs

if [ "${DB:-0}" = 1 ]; then
  step "db:migrate" npm run db:migrate
  step "db:test"    npm test
  step "db:prove"   npm run prove
  step "db:fuzz"    npm run fuzz
  step "db:clean"   npm run db:clean
else
  echo "ci: db matrix skipped (DB=1 to run against live engines)"
fi

if [ -n "$FAILED" ]; then
  echo "ci: FAILED:$FAILED"
  exit 1
fi
echo "ci: all green"
