#!/bin/sh
# Apply the database schema for the engine named by DATABASE_URL, using its native client
# (psql / mysql). Replaced the former TypeScript migrate script. Run by hand or in CI before the SQL
# conformance suites; the running server never creates tables on startup.
#
#   DATABASE_URL=postgres://economy:economy@localhost:5432/economy_lab  sh scripts/migrate.sh
#   DATABASE_URL=mysql://root:economy@localhost:3306/economy_lab        sh scripts/migrate.sh
#   make db-migrate        # reads DATABASE_URL from the environment, falling back to .env
#
# See: https://economy-lab-docs.pages.dev/economy/reference/configuration/  (Configuration)
#
# Both schemas are self-resetting (Postgres resets the `public` schema first; MySQL drops its tables
# and routines up front), so re-running is safe. No DATABASE_URL: nothing to do (the in-memory store
# builds its tables in code).
#
# This is a lab tool: it resets by dropping the schema — right for a throwaway dev/lab database,
# catastrophic for one holding real money. As a guard it refuses a non-local host unless
# MIGRATE_FORCE=1. A real deployment wants additive, versioned migrations instead, not this.
set -eu

# Run from the repo root so the db/*.sql paths resolve regardless of caller cwd.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# For local runs, fall back to .env (CI passes DATABASE_URL in the environment). Only when it is
# not already set, so an explicit `DATABASE_URL=… sh scripts/migrate.sh` always wins.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

url="${DATABASE_URL:-}"

# Destructive-reset guard. This DROPS the schema, so refuse a non-local host unless explicitly
# forced. A throwaway dev/lab database on localhost is always allowed; anything else (a staging or
# production host reached by a stray DATABASE_URL) needs MIGRATE_FORCE=1.
host="${url#*://}"
host="${host#*@}"
host="${host%%/*}"
host="${host%%:*}"
case "$host" in
localhost | 127.0.0.1 | ::1 | "") ;; # local, or no host at all — allowed
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
  # psql takes the connection URL directly. Reset, then apply; stop on the first error.
  # client_min_messages=warning hushes the routine "drop cascades to …" NOTICEs from the reset.
  psql "$url" -v ON_ERROR_STOP=1 -q \
    -c 'set client_min_messages=warning; drop schema public cascade; create schema public;'
  psql "$url" -v ON_ERROR_STOP=1 -q \
    -c 'set client_min_messages=warning' -f db/postgresql-schema.sql
  echo "migrated postgres — public schema reset and db/postgresql-schema.sql applied"
  ;;
mysql*)
  command -v mysql >/dev/null 2>&1 ||
    { echo "scripts/migrate.sh: mysql client not found on PATH" >&2; exit 1; }
  # mysql(1) takes no URL, so split DATABASE_URL into host/port/user/password/database. (Plain
  # credentials only — URL-encoded user/password are not decoded; the dev URLs need none.)
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
