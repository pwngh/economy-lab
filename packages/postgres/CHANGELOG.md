# Changelog

Notable changes to `@pwngh/economy-postgres`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `postgres(url, options?)` opens the pool, gates on the schema stamp, installs and proves the money routines, and returns a `Store`.
- `postgres({ pool })` builds the same store over a pool the caller opened.
- `postgresStore(options)` is the full option surface: schema isolation, table layout, pool sizing, the spend window, and injectable `clock`, `digest`, `meter`, and `logger`.
- `schemaName` isolates a run in its own schema and drops it on close; `layout` provisions standard or hash-partitioned growth tables.
- `connectionTimeoutMillis` defaults to 10s, where `pg` has no default of its own.
- `schema: 'skip'` is the break-glass past the stamp gate; migration is an external job, never an open option.
- `@pwngh/economy-postgres/driver` carries `openPgPool` and `loadPg`, for tooling that keeps its own tables beside the ledger.
