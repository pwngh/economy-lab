# webhook

The inbound gate for [`@pwngh/economy`](../economy). `webhook` reads a bounded body, verifies a
provider's HMAC signature, refuses a delivery outside its freshness window, decodes the body
into a typed event, and only then claims the provider's event id once.

## Features

- **Bounds before proof:** [the body is read under a byte ceiling and a deadline](#bounds), so an
  unauthenticated caller never chooses how much memory the process buys or how long it waits.
- **Proof before meaning:** the signature and the freshness window settle before any decoder
  runs, so a forged delivery never reaches code that touches balances.
- **Signatures over bytes:** HMAC-SHA-256 on the exact bytes that arrived, compared in
  constant time by Web Crypto. [A parsed and re-serialized body will not verify](#raw-bytes).
- **The claim comes last:** a refused or stale delivery burns no event id, so [a genuine
  redelivery](#the-order) still processes.
- **A decoder per provider:** [your own function](#a-provider-decoder) turns one provider's
  payload into a lab `WebhookEvent`; the default reads a purchase.
- **It answers, it does not throw:** every delivery resolves to `verified`, `duplicate`, or
  `refused`, with the message to log. A forgery is a reply; only a broken replay store is an
  exception.
- **Rotation without downtime:** [secrets are a list](#rotating-the-secret), newest first, and a
  delivery verifies under any of them.
- **Zero dependencies of its own:** the lab is the only one, and Web Crypto does the rest.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

```ts
import { createWebhookVerifier } from '@pwngh/economy/webhook';
import { handleWebhook } from '@pwngh/economy-lab/server';

let gate = createWebhookVerifier({
  secrets: [WEBHOOK_SECRET],
  replay: store.replay,
});

let result = await gate.verify('steam', request); // provider from the route, never the body

result.status; // 'verified'
if (result.status === 'verified') {
  await handleWebhook(store, ports, result.event); // the lab applies it, once
}
```

A refusal is a reply, not an exception:

```ts
result.status; // 'refused'
result.reason; // 'signature'
result.message; // "Webhook signature for 'steam' does not match the body."
```

Answer `duplicate` with a 200 and `refused` with a 4xx: `signature` is a 401, `malformed` a 400,
`oversize` a 413, `timeout` a 408. A 5xx on a delivery that will never verify only brings the
provider back with the same bytes.

### The order

The gate runs five steps, in this order, and the order is the point:

1. The byte ceiling and the read deadline — `maxBodyBytes`, 64 KiB by default, and
   `readTimeoutMs`, ten seconds. Past either, the stream is cancelled and the answer is
   `refused` with reason `oversize` or `timeout`.
2. The HMAC signature, over the raw bytes.
3. The freshness window — `x-timestamp` within `freshnessWindowMs` of now, five minutes by
   default. Outside it, or missing, the answer is `duplicate` with reason `stale`.
4. The decoder, which reads the provider's `eventId` out of the body.
5. The replay claim on that id. A second arrival is `duplicate` with reason `replay`.

An unverified delivery stops at step one or two, having claimed nothing and decoded nothing.
The bounds come first because every step after them spends memory or time on a caller who has
proved nothing yet.

### Bounds

```ts
let gate = createWebhookVerifier({
  secrets: [WEBHOOK_SECRET],
  maxBodyBytes: 64 * 1024, // optional
  readTimeoutMs: 10_000, // optional
});
```

Both default to the lab's own constants, so this gate and the lab's webhook route refuse at the
same size. A declared `content-length` past the ceiling is refused before a byte is read; a
lying or absent one is caught by counting as chunks arrive. A body trickled a byte at a time
never crosses the ceiling, which is what the deadline is for. Either verdict cancels the stream
rather than leaving it open.

`verifyDelivery` applies the ceiling to the `raw` it is handed, before the signature. The
deadline belongs to reading and does not apply there.

A value that is not a finite, non-negative number throws at construction. `Number` of an unset
environment variable is `NaN`, every comparison against `NaN` is false, and the result would be
the ceiling off with nothing to see.

### The freshness window is not a replay defence

`x-timestamp` arrives in a header the signature does not cover. Anyone holding a captured
delivery can re-date it to now and it verifies exactly as it did the first time, however old it
is. The window bounds clock skew between you and the provider; it has never bounded replay, and
until this release its name said otherwise.

What refuses the second arrival is claiming the event id. Pass `replay` and the gate claims it;
end at [`handleWebhook`](../economy) and the lab's inbox claims the same id again. A host that
does neither has no replay defence.

### Raw bytes

```ts
await gate.verifyDelivery({
  // for a host that already holds the bytes
  provider: 'steam',
  raw: rawBytes, // the bytes that arrived, not a re-encoding
  signature: headers['x-signature'],
  timestamp: headers['x-timestamp'],
});
```

Mount this before any body parser, or hand it the raw body — a signature covers bytes, not
meaning, so a body that was parsed and re-serialized fails to verify even when nothing about
it changed. [`@pwngh/economy-adapters`](../adapters) shows the raw-body form for each
framework.

### A provider decoder

```ts
let gate = createWebhookVerifier({
  secrets: [WEBHOOK_SECRET],
  decoders: {
    rail: ({ provider, body }) => ({
      // throw to refuse; the message reaches the caller
      kind: 'payoutSettled',
      provider,
      eventId: body.id,
      sagaId: body.payout_id,
      providerRef: body.reference,
    }),
  },
});
```

The default decoder reads a purchase: `eventId`, `userId`, `source`, `amount`, and an optional
`sku`.
A provider whose callbacks are payouts or disputes brings its own.

### Rotating the secret

```ts
let gate = createWebhookVerifier({ secrets: [NEXT_SECRET, CURRENT_SECRET] });
```

An inbound signature names no key, so every secret is tried. Rotation is therefore a window:
prepend the new secret, wait for the provider to switch, then drop the old one. At least one is
required and each must be a non-empty string, so an unset environment variable is refused at
construction rather than becoming a key made of its own name.

`signBody(raw, secret)` signs bytes the way a provider would, under one named secret. It is the
outbound direction and nothing in the verify path calls it. Use it to drive your own endpoint in
a test, or to replay a delivery against a rotated secret, rather than re-deriving the encoding by
hand — two hand-rolled implementations of one signature are how they quietly stop agreeing. Do
not sign real outbound traffic with a secret you hold for verifying inbound.

### Telemetry

```ts
let gate = createWebhookVerifier({
  secrets: [WEBHOOK_SECRET],
  meter: ports.meter,
});
```

Every duplicate this gate answers counts as `economy.webhook.duplicate`, tagged `provider` and
`layer` (`stale` or `replay`) — the same counter, under the same name, that the lab's own webhook
route emits. The replay-storm runbook and the ops detector both read it by name, so a host
swapping this gate in for that route keeps the signal.

### What it does not do

It does not post to the ledger, hold a database handle, or dedupe by anything but the
provider's `eventId`. It hands you a verified event; applying it is
[`handleWebhook`](../economy)'s job, and the inbox dedupes there a second time on the same id.
It does not run unverified: a missing or unusable secret is refused at construction rather than
passed through.

## Related Packages

- [`@pwngh/economy`](../economy) — applies the verified event to the ledger
- [`@pwngh/economy-events`](../events) — the outbound direction: what the economy emits
- [`@pwngh/economy-adapters`](../adapters) — raw bytes through your framework's body pipeline

## License

[MIT](../../LICENSE.md)
