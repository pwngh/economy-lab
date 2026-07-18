# Developer entry points: wraps the npm scripts and drives the database/Docker tooling.

.DEFAULT_GOAL := help
.PHONY: help up down bootstrap db-migrate db-clean test coverage check prove fuzz prop smoke bench bench-prod scale trace demo demo-ops demo-ops-integrity demo-ops-deadlock backup restore-drill audit-verify ledger-verify dev start worker samples

help: ; @printf '%s\n' 'targets:' '  up down bootstrap db-migrate db-clean' '  test coverage check prove fuzz prop smoke bench bench-prod scale trace demo samples' '  demo-ops demo-ops-integrity demo-ops-deadlock' '  dev start worker' '' 'make bootstrap  = up + wait for health + db-migrate (one-step setup)' 'make db-migrate = apply the schema for $$DATABASE_URL (or .env) via psql/mysql' 'make db-clean   = drop orphaned throwaway namespaces a killed run left behind (el_* schemas/databases)' 'make coverage   = the test suite with per-file line/branch coverage' 'make prop       = property-based ledger laws with a shrinking counterexample search (in-memory)' 'make bench      = throughput + integrity bench (in-memory + any reachable DB), reseeded per run' 'make bench-prod = run the bench INSIDE a Linux container vs the compose DBs (production-parity fsync)' 'make scale      = per-subject scale probe across backends (does per-op cost stay flat as history grows?)' 'make samples    = compile the docs fenced ts samples against the real entry points' 'make demo-ops   = ops supervisor demos: stuck-saga closed loop; -integrity = tamper escalation; -deadlock = retry storm (needs DATABASE_URL; make bootstrap first)' 'make backup     = data-only dump of every env-named engine into backups/ (pg_dump/mysqldump)' 'make restore-drill = restore the newest dump into a scratch el_drill_* namespace and prove it' 'make audit-verify FILE=<jsonl> = re-derive a hash-chained ops audit trail and report the first break' 'make ledger-verify FILE=<jsonl> KEY=<hex public key> = offline chain + checkpoint verification of a read.export file'

up:         ; sh scripts/docker.sh up -d
down:       ; sh scripts/docker.sh down
bootstrap:  ; sh scripts/docker.sh bootstrap
db-migrate: ; sh scripts/migrate.sh
db-clean:   ; npm run db:clean
test:       ; npm test
coverage:   ; npm run coverage
check:      ; npm run check
prove:      ; npm run prove
fuzz:       ; npm run fuzz
prop:       ; npm run prop
smoke:      ; npm run smoke
bench:      ; npm run bench
bench-prod: ; sh scripts/docker.sh run --rm bench
scale:      ; npm run scale
trace:      ; npm run trace
samples:    ; npm run check:samples
demo:       ; npm run demo
demo-ops:           ; npm run demo:ops
demo-ops-integrity: ; npm run demo:ops -- integrity
demo-ops-deadlock:  ; npm run demo:ops -- deadlock
backup:             ; npm run backup
restore-drill:      ; npm run restore:drill
audit-verify:       ; npm run audit:verify -- $(FILE)
ledger-verify:      ; npm run ledger:verify -- $(FILE) $(if $(KEY),--key $(KEY))
dev:        ; npm run dev
start:      ; npm start
worker:     ; npm run worker
