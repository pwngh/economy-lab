# Test layout

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
