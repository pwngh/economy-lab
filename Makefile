# Developer entry points. The JS tasks live in package.json. This Makefile drives the database and
# Docker tooling and wraps the common npm scripts. It lets `make <target>` work from a clean checkout.
# Schema migration uses the native clients (psql / mysql) via scripts/migrate.sh.

.DEFAULT_GOAL := help
.PHONY: help up down bootstrap db-migrate test check prove fuzz smoke bench trace demo dev start worker

help: ; @printf '%s\n' 'targets:' '  up down bootstrap db-migrate' '  test check prove fuzz smoke bench trace demo' '  dev start worker' '' 'make bootstrap  = up + wait for health + db-migrate (one-step setup)' 'make db-migrate = apply the schema for $$DATABASE_URL (or .env) via psql/mysql'

up:         ; sh scripts/docker.sh up -d
down:       ; sh scripts/docker.sh down
bootstrap:  ; sh scripts/docker.sh bootstrap
db-migrate: ; sh scripts/migrate.sh
test:       ; npm test
check:      ; npm run check
prove:      ; npm run prove
fuzz:       ; npm run fuzz
smoke:      ; npm run smoke
bench:      ; npm run bench
trace:      ; npm run trace
demo:       ; npm run demo
dev:        ; npm run dev
start:      ; npm start
worker:     ; npm run worker
