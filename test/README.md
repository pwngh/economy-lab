# Tests

## Conventions

- Standard `node:test` idiom: `describe` per module or facet, `test('does the thing', async () => {...})`
  with the body inline. No indirection — a test you can read top to bottom without chasing a
  function defined elsewhere in the file.
- Titles are plain sentences naming one observable behavior, usually with the error code or
  reason code spelled out (`throws LEDGER.UNBALANCED when a posting does not sum to zero`).
  One behavior per test.
- Extract a helper only when two or more tests share it; single-use setup stays in the test body.
  Cross-file fixtures live in `support/` — check there before writing a local one.
- Backend-gated files (Postgres, MySQL, Redis) self-skip when the backend is unreachable, so the
  suite is always green from a bare clone. When auditing a green run, check the skip counts.

## Layout

- `<module>.test.ts` — unit level: calls the handler or module directly with a hand-built `Ctx`.
- `<module>.submit.test.ts` — pipeline level: drives the full public `economy.submit` path
  (authorization, idempotency, locking) that the plain file bypasses. `events.submit.test.ts` and
  `velocity.submit.test.ts` have no unit sibling; the suffix there just means "exercises submit".
- `economy.<facet>.test.ts` — one cross-cutting facet of the economy (cache, pause, velocity…).
- `conformance/` — every storage backend runs the same suites; `<scenario>.race.test.ts` and
  `<facet>.adversarial.test.ts` add concurrency and hostile-input flavors.
- `support/` — the shared deterministic doubles. Reach for `makeEconomy` / `economyWithStore` /
  `makeCtx(overrides)` / `hasCode` and the `buildX` operation builders before writing a local
  fixture.
