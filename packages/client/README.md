# client

The typed wire client for [`@pwngh/economy`](../economy). `client` calls the seven `/v1`
reads and the one `/submit` write, and nothing else — the wire's vocabulary is the whole
surface.

## Features

- **One method per route:** `wallet`, `entitlements`, `subscriptions`, `payouts`, `rates`,
  `catalog`, `posting`, and `submit`. No domain verbs, so nothing here can drift from what
  the host actually serves.
- **A rejection is data:** a decline resolves with a reason you can read; only transport and
  auth failures throw. [The two guards](#reading-an-outcome) tell them apart.
- **Bearers that rotate:** `token` takes a function as readily as a string, so [a refreshing
  session](#a-rotating-token) keeps one client rather than rebuilding it per token.
- **Browser-safe:** Fetch and Web Crypto only, no Node built-ins, and the global `fetch` is
  bound before use so a detached call never trips a browser.
- **Zero dependencies of its own:** the lab is the only one, and it is the request logic.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

```ts
import {
  createClient,
  isRejected,
  newIdempotencyKey,
} from '@pwngh/economy/client';

let client = createClient({
  baseUrl: 'https://api.example.com',
  token: session.token,
});

await client.wallet(); // { spendable: 'CREDIT:600.00', earned: 'CREDIT:0.00', promo: 'CREDIT:0.00' }

let outcome = await client.submit({
  kind: 'spend',
  idempotencyKey: newIdempotencyKey('checkout'),
  buyerId: 'usr_ada',
  sku: 'world-kit',
  price: 'CREDIT:600.00',
  recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
});

isRejected(outcome) && outcome.reason; // 'INSUFFICIENT_FUNDS'
```

Ship only a user token to a browser. System and operator tokens stay server-side, where a
client built with one runs under the host's own principal.

### Reading an outcome

```ts
import { isCommitted, isRejected } from '@pwngh/economy/client';

isCommitted(outcome); // true for 'committed' and for 'duplicate'
isRejected(outcome); // true for 'rejected'; outcome.detail carries the specifics
```

A `duplicate` is the same posting handed back to a retry, so it is a success. Treating it as
a failure and retrying with a fresh key is how a caller charges twice.

### A rotating token

```ts
let client = createClient({
  baseUrl: 'https://api.example.com',
  token: async () => (await session.refreshIfExpired()).token, // read once per request
  headers: { 'x-request-id': 'req_4c1d9e' }, // on every request
  fetch: myFetch, // defaults to the global
});
```

### Calling your own routes

A host route takes the same session but speaks the host's vocabulary, not the wire's, so it has
no client method. `createTransport` hands you the credential stamping `createClient` is built on
rather than leaving you to copy it.

```ts
import { createTransport } from '@pwngh/economy/client';

let post = createTransport({ token: () => session.token });

let res = await post('https://storefront.example.com/checkout', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sku: 'world-kit' }),
});
```

### Idempotency keys

```ts
let key = newIdempotencyKey('checkout'); // 'checkout_9f3c1a7e-...'
```

Keep the key with the intent it stands for. A retry of the same purchase sends the same key;
a new key is a new purchase, and the ledger will post it. Web Crypto supplies the randomness,
so a browser needs a secure context.

### What it does not do

No caching, no retries, no polling, and no token storage. A read is one request, a `submit`
is one request, and what to do about a slow network is the caller's call.

## Related Packages

- [`@pwngh/economy`](../economy) — the host this client calls
- [`@pwngh/economy-events`](../events) — the events that follow a `submit` that committed
- [`@pwngh/economy-ui`](../ui) — React hooks over these same reads

## License

[MIT](../../LICENSE.md)
