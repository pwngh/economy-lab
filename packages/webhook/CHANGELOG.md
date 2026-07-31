# Changelog

Notable changes to `@pwngh/economy-webhook`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `createWebhookVerifier(options)` returns a gate that runs the byte ceiling and the read deadline, then the signature, then the freshness window, then a decoder, then the replay claim.
- The claim is last, so a refused or stale delivery burns no event id.
- `maxBodyBytes` and `readTimeoutMs` bound the body `gate.verify` reads off a `Request`, defaulting to the lab's `DEFAULT_MAX_BODY_BYTES` and `DEFAULT_READ_TIMEOUT_MS`. A `content-length` past the ceiling is refused before a byte is read, a lying or absent one is caught by counting, and either verdict cancels the stream.
- The ceiling settles before the signature, and `gate.verifyDelivery` applies it to the `raw` it is handed.
- `RefusedWebhook.reason` is `signature`, `malformed`, `oversize`, or `timeout`.
- `gate.verify(provider, request)` reads the raw bytes and both headers off a Fetch `Request`; `gate.verifyDelivery(input)` is the same gate for a host that already holds them.
- Every delivery resolves to `verified`, `duplicate`, or `refused`. No delivery is an exception; a replay store that fails is, so a store outage never becomes a verdict.
- `verifySignature(raw, signature, secrets)` is HMAC-SHA-256 over the raw bytes, lowercase hex, compared in constant time by Web Crypto.
- `decoders` maps a provider to a function that turns its payload into a lab `WebhookEvent`. A provider with no entry gets the lab's purchase decoder.
- `secrets` is a list, newest first, so a rotation is a prepend. An empty list, or an entry that is not a non-empty string, throws at construction rather than passing deliveries through unverified.
- `freshnessWindowMs` and `DEFAULT_FRESHNESS_WINDOW_MS` bound how far a delivery's timestamp may sit from now. They bound clock skew, not replay: the timestamp arrives in a header the signature does not cover, so a captured delivery re-dated to now verifies again. `replay` claims the event id and is the replay defence the gate has.
- A `freshnessWindowMs`, `maxBodyBytes`, or `readTimeoutMs` that is not a finite, non-negative number throws at construction.
- A `verified` result carries `raw`, the exact bytes the signature covered.
