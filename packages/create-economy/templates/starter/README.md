# {{PROJECT_NAME}}

A credits storefront on a double-entry ledger: wallets, a top-up menu, and a checkout that prices itself from your own listings.

## Features

- **One file is the app** - `economy.app.ts` exports named seams; `economy check` prints exactly what they compile to
- **One dependency** - `@pwngh/economy` carries the ledger, the command, the auth resolvers, and the test harness
- **The catalog is the price authority** - a client that names its own price is refused `CATALOG_MISMATCH` before the ledger sees the spend
- **Runs with no database** - `npm run dev` boots a memory store and dev tokens; `npm start` refuses to bind until the real environment is set
- **No accounting to write** - every credit that moves is two entries, and the ledger keeps the books

## Installation

```sh
npm install
```

Node 22.18 or newer. Nothing else is required to run the dev loop.

## Usage

The dev loop is three commands, and none of them need a database:

```sh
npm run check   # the module and the environment compiled to one truth pass
npm run dev     # http://127.0.0.1:3000, memory store, dev tokens
npm test        # the same arc on deterministic ports, no socket
```

With `npm run dev` running, the dev tokens answer on loopback:

```sh
curl http://127.0.0.1:3000/healthz
# {"status":"ok"}

curl -H 'authorization: Bearer dev_user_ada' http://127.0.0.1:3000/v1/wallet
# {"spendable":"CREDIT:0.00","earned":"CREDIT:0.00","promo":"CREDIT:0.00","payableNow":"CREDIT:0.00"}
```

### Putting credits in a wallet

A top-up is a system operation: your payment provider is the one claiming money arrived, so a user token cannot run it.

```sh
curl -X POST http://127.0.0.1:3000/submit \
  -H 'authorization: Bearer dev_system_payments' \
  -H 'content-type: application/json' \
  -d '{"kind":"topUp","idempotencyKey":"ord-1","userId":"usr_ada","amount":"CREDIT:600.00","source":"card"}'
# {"status":"committed", ...}
```

### Spending them

The checkout route takes a sku and an order id. Everything else — the price, the split, the buyer — comes from the catalog and the authenticated principal, so the client cannot forge any of it.

```sh
curl -X POST http://127.0.0.1:3000/checkout \
  -H 'authorization: Bearer dev_user_ada' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: ord-2' \
  -d '{"sku":"starter-pack","orderId":"ord-2"}'
# {"status":"committed", ...}
```

Every route that moves money needs that `idempotency-key` header. Send the same key twice and the second call returns the first result instead of charging again.

### Editing the app

`economy.app.ts` is the whole application. Add a listing to the map, and the checkout prices it:

```ts
let listings = new Map([
  [
    'starter-pack',
    {
      price: credits(120),
      recipients: [{ sellerId: STORE, shareBps: 10_000 }],
    },
  ],
  [
    'world-kit',
    {
      price: credits(2_500),
      recipients: [{ sellerId: STORE, shareBps: 10_000 }],
    },
  ],
  [
    'avatar-bundle',
    {
      price: credits(8_000),
      recipients: [{ sellerId: STORE, shareBps: 10_000 }],
    },
  ],
]);
```

Every sale names who earned it, so a first-party store names its own account for the whole 10,000 basis points. An empty `recipients` is refused — the ledger will not post a sale with no earner:

```ts
let offer = { price: credits(8_000), recipients: [] };
// OP.MALFORMED: A spend names at least one recipient.
```

To pay real sellers, list them with the shares they split. Shares must sum to 10,000, and rounding remainders go to platform revenue:

```ts
let offer = {
  price: credits(8_000),
  recipients: [
    { sellerId: 'usr_ben', shareBps: 7_000 }, // 70% of the net
    { sellerId: 'usr_cal', shareBps: 3_000 }, // 30%
  ],
};
```

The `marketplace` template starts from that shape, with payouts and a provider webhook already wired.

### Going to production

`npm start` is `economy serve`, which is deliberately harder to satisfy than `economy dev`. It refuses to bind while any dev stand-in is still in place:

```sh
npm run build
NODE_ENV=production npm start
# preflight  {"code":"secret.missing","path":"WEBHOOK_SECRET", ...}
# serve refuses dev stand-ins — fix the environment (economy check shows it)
```

Copy `.env.example` to `.env` and fill it in. It lists every value production requires: a real `DATABASE_URL`, both secrets, the three conversion rates, the maturity horizon, the processor URL, and an explicit decision on each optional port.

One of those values needs three lines of code as well. The framework never imports a database driver from a URL scheme, so `DATABASE_URL` only names the engine you meant — the module states the store. Add these lines to `economy.app.ts`, through the door that matches your URL:

```ts
import { postgres } from '@pwngh/economy/postgres'; // mysql:// → `@pwngh/economy/mysql`

export const ports = {
  store: await postgres(process.env.DATABASE_URL),
};
```

Until they are there, `npm run check` refuses the production environment and names the missing store.

### Shipping it

The `Dockerfile` builds a two-stage image: the first stage compiles with the dev dependencies, the second ships only what production needs. It builds straight from a fresh scaffold — the build stage writes a lockfile when the project has none yet, and once `npm install` has written yours, the image pins itself to it:

```sh
docker build -t {{PROJECT_NAME}} .
docker run --env-file .env -p 3000:3000 {{PROJECT_NAME}}
```

The image serves the compiled `dist/economy.app.js`, never the TypeScript. Its health check calls `/readyz` with node itself, because the slim base carries no curl. The command is exec form, so the process is PID 1 and gets the `SIGTERM` that drains it in flight.

`docker run` will exit immediately without a real environment: `economy serve` refuses to bind while any dev stand-in is in place, and that includes an unset `DATABASE_URL`.

### What this template does not do

- No user accounts. `authenticate` is where your identity provider goes; the dev tokens are a placeholder that answers only on loopback and never in production
- No payment provider. `topUp` is submitted by a trusted system caller; wiring Stripe or another rail to it is yours
- No payouts. Credits go in and get spent; the `marketplace` template adds the arc that sends money back out
- No orchestration. The image is one process; a database, a scheduler, and a queue are yours to run beside it
- No front end. The server answers JSON; `@pwngh/economy/ui` has React hooks for the reads when you want them
- No migrations run for you. `economy serve` expects the schema to already be there

## Related Packages

- [`@pwngh/economy`](https://github.com/pwngh/economy-lab/tree/main/packages/economy) - The one dependency this project installs, and the `economy` command it runs
- [`@pwngh/economy-lab`](https://github.com/pwngh/economy-lab) - The ledger underneath, one line away when you need pools, sweeps, or the proof surface

## License

This project is yours. The packages it installs are MIT.
