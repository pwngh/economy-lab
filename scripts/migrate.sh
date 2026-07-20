#!/bin/sh
# Applies the database schema for the engine named by DATABASE_URL, using that engine's native
# client (psql or mysql). The running server never creates tables on startup.
#
#   DATABASE_URL=postgres://economy:economy@localhost:55432/economy_lab  sh scripts/migrate.sh
#   DATABASE_URL=mysql://root:economy@localhost:53306/economy_lab        sh scripts/migrate.sh
#   make db-migrate        # reads DATABASE_URL from the environment, falling back to .env
#
# See: https://economy-lab-docs.pages.dev/economy/reference/configuration/  (Configuration)
#
# Both schemas are self-resetting, so re-running is safe — this is a lab reset tool, not a
# migration system. A real deployment wants additive, versioned migrations instead.
set -eu

# Run from the repo root so the db/*.sql paths resolve regardless of caller cwd.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# For local runs, fall back to .env (CI passes DATABASE_URL in the environment). Only when it is
# not already set, so an explicit `DATABASE_URL=... sh scripts/migrate.sh` always wins.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

url="${DATABASE_URL:-}"

# Destructive-reset guard: this DROPS the schema, so any non-local host needs MIGRATE_FORCE=1.
host="${url#*://}"
host="${host#*@}"
host="${host%%/*}"
host="${host%%:*}"
case "$host" in
localhost | 127.0.0.1 | ::1 | "") ;; # local, or no host at all: allowed
*)
  [ "${MIGRATE_FORCE:-}" = "1" ] || {
    echo "scripts/migrate.sh: refusing to reset a non-local database ($host) — this DROPS the schema." >&2
    echo "  This is a lab tool. If you truly mean it, re-run with MIGRATE_FORCE=1." >&2
    exit 1
  }
  ;;
esac

case "$url" in
postgres* | postgresql*)
  command -v psql >/dev/null 2>&1 ||
    { echo "scripts/migrate.sh: psql not found on PATH" >&2; exit 1; }
  # client_min_messages=warning hushes the routine "drop cascades to ..." NOTICEs from the reset.
  psql "$url" -v ON_ERROR_STOP=1 -q \
    -c 'set client_min_messages=warning; drop schema public cascade; create schema public;'
  psql "$url" -v ON_ERROR_STOP=1 -q \
    -c 'set client_min_messages=warning' -f db/postgresql-schema.sql
  echo "migrated postgres — public schema reset and db/postgresql-schema.sql applied"
  ;;
mysql*)
  command -v mysql >/dev/null 2>&1 ||
    { echo "scripts/migrate.sh: mysql client not found on PATH" >&2; exit 1; }
  # mysql(1) takes no URL, so split DATABASE_URL into host, port, user, password, and database. Only
  # plain credentials work here: a URL-encoded user or password is not decoded, and the dev URLs need
  # no decoding.
  rest="${url#mysql://}"
  case "$rest" in
  *@*) creds="${rest%%@*}"; hostpart="${rest#*@}" ;;
  *)   creds="";            hostpart="$rest" ;;
  esac
  user="${creds%%:*}"
  case "$creds" in *:*) pass="${creds#*:}" ;; *) pass="" ;; esac
  hostport="${hostpart%%/*}"
  database="${hostpart#*/}"; database="${database%%\?*}"
  host="${hostport%%:*}"
  case "$hostport" in *:*) port="${hostport#*:}" ;; *) port="3306" ;; esac
  # MYSQL_PWD keeps the password off the process list and out of the insecure-on-CLI warning.
  MYSQL_PWD="$pass" mysql --host="$host" --port="$port" --user="$user" \
    --default-character-set=utf8mb4 "$database" <db/mysql-schema.sql
  echo "migrated mysql — db/mysql-schema.sql applied"
  ;;
"")
  echo "no DATABASE_URL set — the in-memory store needs no schema; nothing to migrate."
  ;;
*)
  echo "scripts/migrate.sh: unsupported DATABASE_URL scheme: ${url%%:*}" >&2
  exit 1
  ;;
esac
