# test

The deterministic harness for [`@pwngh/economy`](../economy). It runs your real module on a
clock that only moves when you say so, with sequential ids and memory storage, so two runs
of the same test produce the same rows.

## Features

- **Your real module:** `openTestEconomy(definition)` boots the same seams `economy dev`
  boots — no parallel test-only assembly to drift from production.
- **Personas, not fixtures:** actors that carry their own credentials and submit the same
  drafts your route handlers return.
- **Time you control:** [the clock advances on command](#time), so maturity horizons,
  payout holds, and renewals are exact rather than slept-through.
- **Snapshot-stable output:** `canonicalForm(value)` renders sorted keys, named functions,
  and decimal-string bigints.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

```ts
import { openTestEconomy } from '@pwngh/economy/test';
import { credits } from '@pwngh/economy/money';
import * as module from '../economy.app.ts';

let eco = await openTestEconomy(module);
let ada = eco.user('ada');

await eco.fund(ada, credits(500));
await ada.submit({
  kind: 'spend',
  orderId: 'ord_1',
  sku: 'world-kit',
  price: credits(400),
  recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
});

(await ada.wallet()).spendable; // credits(100)
await eco.close();
```

Dev policy is real policy: the velocity cap is 1,000 credits an hour and the payout minimum
is 20,000 credits. A test that runs a whole arc keeps its amounts under the cap, or states
the one knob it lowers — a spread over your module is how.

### Personas

```ts
let ada = eco.user('ada'); // a user token; its own userId is inferred on drafts
let payments = eco.system('payments'); // a system actor, for the operations users cannot do
let ops = eco.operator('ops_1'); // an operator actor

await ada.request('/checkout', { method: 'POST', body: '{"sku":"world-kit"}' }); // your route
(await ada.wallet()).earned; // this persona's own wallet, over the same reads
```

`persona.submit(draft)` stamps the actor and a sequential idempotency key, so a test never
invents one.

### Time

```ts
eco.clock.advance(30 * 24 * 60 * 60_000); // a month
await eco.worker.tick(); // one full worker cycle plus the fast lanes
await eco.until(async () => (await payout.saga!.state()) === 'SETTLED');
```

`eco.until(check)` cycles advance-plus-tick until the condition holds, so a test never
sleeps on a real timer.

### Hostile inputs

Two probes for the suites that attack a seam rather than run an economy through it:

```ts
import { signEdDSAToken, throwingGetter } from '@pwngh/economy/test';

let { privateKey } = (await crypto.subtle.generateKey('Ed25519', true, [
  'sign',
  'verify',
])) as CryptoKeyPair;
let token = await signEdDSAToken(
  { sub: 'usr_ada', exp: Date.now() / 1000 + 60 },
  { privateKey, kid: 'k1' },
); // a compact EdDSA JWS your authJwks posture verifies

let hostile = throwingGetter('policy', new TypeError('lazy require exploded'), {
  authenticate: false,
}); // a module namespace whose `policy` export throws on first read
```

`signEdDSAToken` writes the claims exactly as given — no `exp` default, no issuer stamp.
Omit `kid` and the header carries none, so key choice falls to the verifier's algorithm
filter alone.

### The rail

```ts
await eco.rail.settle(payout); // the same protocol step a provider webhook drives
eco.rail.mode = 'auto-settle'; // every SUBMITTED saga settles on the next tick
```

## Related Packages

- [`@pwngh/economy-core`](../core) — the module contract this harness boots
- [`@pwngh/economy-cli`](../cli) — the same module under `economy dev`

## License

[MIT](../../LICENSE.md)
