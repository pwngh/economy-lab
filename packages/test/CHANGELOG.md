# Changelog

Notable changes to `@pwngh/economy-test`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- The persona test harness, reached through `economy/test`.
- `openTestEconomy(definition)` gives `user`, `system`, and `operator` personas that submit drafts with their own actor, sequential idempotency keys, and own-subject inference.
- A persona reads its own wallet, and `fund` credits a user.
- `rail.settle` and `rail.fail` drive a payout saga through the door; `rail.mode` is `manual` by default, and `auto-settle` settles every SUBMITTED saga on tick.
- `until(check)` cycles `clock.advance(31_000)` plus a worker tick up to 20 times.
- `persona.request(path)` sends the persona's `dev_<kind>_<label>` bearer; when the definition states no `authenticate`, the harness resolves that grammar itself.
- `openTestEconomy(definition, { webhookSecret, now })` threads a webhook secret into the memory ports and pins the clock's start.
- `canonicalForm` renders snapshot-stable output: sorted keys, a function as `[fn <name>]`, and a bigint as its decimal string.
- `signEdDSAToken(claims, { privateKey, kid })` signs a compact EdDSA JWS; omitting `kid` writes a kid-less header.
- `throwingGetter(key, error, seed)` builds a module namespace whose named export throws when read.
