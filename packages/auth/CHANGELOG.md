# Changelog

Notable changes to `@pwngh/economy-auth`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- The `authenticate` posture a module states, reached through `economy/auth`.
- `authJwks(url, opts)` verifies `Authorization: Bearer <jwt>` against a JWKS endpoint on `fetch` plus WebCrypto, over `RS256`, `ES256`, and `EdDSA`.
- The chosen key must agree with the token's algorithm, and a token is exactly three segments, each canonical base64url.
- `exp` and `nbf` are exact unless `clockToleranceMs` widens them; `iss` and `aud` are checked when set.
- `authApiKeys(keys)` maps static bearer keys to principals on SHA-256 digests. `""`, `"undefined"`, `"null"`, and `"[object Object]"` are refused as keys.
- `bearerStack(...resolvers)` returns the first principal and falls through on `null`.
- `devTokens()` is the three-principal dev list; `devTokens.loopbackOnly()` gates it to loopback requests outside production.
- Every resolver requires the `Bearer ` prefix; the scheme name is case-insensitive and a raw credential answers `null`.
- `userActor`, `systemActor`, and `operatorActor` ship here, re-exported from the ledger.
