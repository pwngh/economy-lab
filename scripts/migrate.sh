#!/bin/sh
# Apply the database schema for the engine named by DATABASE_URL, using its native client
# (psql / mysql). Replaces the old scripts/migrate.ts. Run by hand or in CI before the SQL
# conformance suites; the running server never creates tables on startup.
#
#   DATABASE_URL=postgres://user@localhost:5432/economy_lab  sh scripts/migrate.sh
#   DATABASE_URL=mysql://root:pw@localhost:3306/economy_lab  sh scripts/migrate.sh
#   npm run db:migrate     # reads DATABASE_URL from the environment, falling back to .env
#
# Postgres: db/postgresql-schema.sql declares its tables outright (no IF NOT EXISTS), so the
# `public` schema is reset first and the file applied — safe to re-run. MySQL: db/mysql-schema.sql
# drops every table and routine up front, so it is self-resetting. No DATABASE_URL: nothing to do
# (the in-memory store builds its tables in code).
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
