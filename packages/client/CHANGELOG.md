# Changelog

Notable changes to `@pwngh/economy-client`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `createClient({ baseUrl, token, fetch, headers })` returns the lab's own wire client. This package settles the transport and the bearer; every request method is the lab's.
- `token` takes a function as well as a string, read fresh on every request, so a rotating bearer needs one client rather than a new one per token.
- `headers` puts fixed headers on every request; a configured `token` writes `authorization` after them.
- `createTransport({ token, headers, fetch })` returns a `fetch` stamping the same bearer and headers, for requests that do not go through a client method.
- An empty bearer sends no `authorization` header, whether it came from a string or a function.
- A runtime with no global `fetch` throws a `TypeError` naming `options.fetch`.
- `isCommitted` and `isRejected` narrow a `WireOutcome`. `duplicate` reads as committed: it is the same posting handed back to a retry.
- `newIdempotencyKey(prefix?)` mints a key from Web Crypto.
