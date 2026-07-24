#!/bin/sh
# Thin wrapper around Docker Compose for the backing services in docker-compose.yml. Works with
# both the v2 plugin (`docker compose`) and the v1 standalone binary (`docker-compose`).
#
#   sh scripts/docker.sh            # up -d (the default)
#   sh scripts/docker.sh <cmd...>   # any compose subcommand passes straight through
#   sh scripts/docker.sh bootstrap  # up -d, wait for health, then apply the schema (migrate.sh)
#
# Via npm, extra args need the `--` separator: `npm run docker -- down`.
# See: https://economy-lab-docs.pages.dev/economy/reference/configuration/  (Configuration)
set -eu

# Run from the repo root so docker-compose.yml is found regardless of caller cwd.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "scripts/docker.sh: need either 'docker compose' (v2) or 'docker-compose' (v1) on PATH" >&2
  exit 1
fi

# Poll every running compose container until each is healthy or declares no healthcheck.
# Override the ceiling with HEALTH_TIMEOUT (seconds, default 120).
wait_healthy() {
  timeout=${HEALTH_TIMEOUT:-120}
  elapsed=0
  while :; do
    # shellcheck disable=SC2086
    ids=$($DC ps -q)
    [ -z "$ids" ] && { echo "scripts/docker.sh: no containers are running" >&2; return 1; }
    pending=0
    for id in $ids; do
      status=$(docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$id" 2>/dev/null || echo missing)
      case "$status" in
        healthy | none) ;; # ready, or no healthcheck declared
        *) pending=$((pending + 1)) ;;
      esac
    done
    [ "$pending" -eq 0 ] && return 0
    [ "$elapsed" -ge "$timeout" ] && {
      echo "scripts/docker.sh: timed out after ${timeout}s waiting for services to be healthy" >&2
      return 1
    }
    sleep 2
    elapsed=$((elapsed + 2))
  done
}

# Migrates against DATABASE_URL if set, else the compose Postgres instance.
bootstrap() {
  echo "==> materializing compose-local URLs into .env (make env)"
  sh scripts/env-merge.sh
  : "${DATABASE_URL:=postgres://economy:economy@localhost:55432/economy_lab}"
  export DATABASE_URL
  echo "==> starting services"
  # shellcheck disable=SC2086
  $DC up -d
  echo "==> waiting for services to report healthy"
  wait_healthy
  echo "==> migrating: $DATABASE_URL"
  sh scripts/migrate.sh
  echo "==> ready — start the app with 'make start' (or 'make worker')"
}

[ "$#" -eq 0 ] && set -- up -d

case "$1" in
  bootstrap)
    bootstrap
    ;;
  *)
    # Word-splitting $DC is intentional, because it holds either "docker compose" or "docker-compose".
    # shellcheck disable=SC2086
    exec $DC "$@"
    ;;
esac
