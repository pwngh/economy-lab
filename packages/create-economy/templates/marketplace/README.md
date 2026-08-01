# {{PROJECT_NAME}}

A credits marketplace on a double-entry ledger: buyers top up, sellers earn a share of every sale, and settled payouts send real money back out.

## Features

- **One file is the app** - `economy.app.ts` exports named seams; `economy check` prints exactly what they compile to
- **One dependency** - `@pwngh/economy` carries the ledger, the command, the auth resolvers, and the test harness
- **Splits that always add up** - recipient shares are basis points summing to 10,000, and the rounding remainder goes to platform revenue rather than vanishing
- **Payouts as a saga** - a cash-out is a state machine against your rail, resumed by the worker, and settled by a verified provider webhook
- **Runs with no database** - `npm run dev` boots a memory store and dev tokens; `npm start` refuses to bind until the real environment is set

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
npm test        # the sale and the payout saga on deterministic ports, no socket
```

### The sale

A buyer needs credits first. A top-up is a system operation, because your payment provider is the one claiming money arrived:

```sh
curl -X POST http://127.0.0.1:3000/submit \
  -H 'authorization: Bearer dev_system_payments' \
  -H 'content-type: application/json' \
  -d '{"kind":"topUp","idempotencyKey":"tu-1","userId":"usr_ada","amount":"CREDIT:30000.00","source":"card"}'
# {"status":"committed", ...}
```

Then the checkout. The client names only a sku and an order id; price, split, and buyer come from the catalog and the authenticated principal:

```sh
curl -X POST http://127.0.0.1:3000/checkout \
  -H 'authorization: Bearer dev_user_ada' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: ord-1' \
  -d '{"sku":"world-kit","orderId":"ord-1"}'
# {"status":"committed", ...}
```

Every route that moves money needs that `idempotency-key` header. Send the same key twice and the second call returns the first result instead of charging again.

The seller's share lands in `earned`, not `spendable`. Earned credits are the ones that can leave the economy:

```sh
curl -H 'authorization: Bearer dev_user_ben' http://127.0.0.1:3000/v1/wallet
# {"spendable":"CREDIT:0.00","earned":"CREDIT:21175.00","promo":"CREDIT:0.00","payableNow":"CREDIT:0.00"}
```

`payableNow` is zero until the funding behind those credits matures. That horizon is the window in which a card charge can still be reversed, and paying out inside it is how a marketplace gets drained.

### The payout

A seller asks for their own credits. The ledger checks the minimum, the maturity horizon, and the daily cooldown before it opens a saga:

```sh
curl -X POST http://127.0.0.1:3000/payouts \
  -H 'authorization: Bearer dev_user_ben' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: payout-1' \
  -d '{"amount":20000}'
# {"status":"committed", ...}
```

The worker drives the saga from there. The rail confirms with a webhook, which is the only thing that moves it to `SETTLED`:

```sh
curl -X POST http://127.0.0.1:3000/webhooks/pay \
  -H 'content-type: application/json' \
  -d '{"kind":"payoutSettled","id":"evt-1","sagaId":"sag_...","ref":"tr_9f21"}'
```

`npm test` walks that whole arc without a socket, using `eco.rail.settle` in place of the provider.

### Editing the app

Add a listing and the checkout prices it. Shares are basis points and must sum to 10,000:

```ts
let listings = new Map([
  [
    'world-kit',
    {
      price: credits(25_000),
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    },
  ],
  [
    'collab-kit',
    {
      price: credits(30_000),
      recipients: [
        { sellerId: 'usr_ben', shareBps: 7_000 }, // 70% of the net
        { sellerId: 'usr_cal', shareBps: 3_000 }, // 30%
      ],
    },
  ],
]);
```

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

- No payment provider. `providers.pay` decodes a payload shape invented for this template; replacing it with your rail's real one is the first thing to do
- No identity provider. The dev tokens answer only on loopback and never in production; `authenticate` is where yours goes
- No seller onboarding. Sellers are user ids in a listing; know-your-customer checks and payout destinations live in your own system
- No orchestration. The image is one process; a database, a scheduler, and a queue are yours to run beside it
- No front end. The server answers JSON; `@pwngh/economy/ui` has React hooks for the reads when you want them
- No migrations run for you. `economy serve` expects the schema to already be there

## Related Packages

- [`@pwngh/economy`](https://github.com/pwngh/economy-lab/tree/main/packages/economy) - The one dependency this project installs, and the `economy` command it runs
- [`@pwngh/economy-lab`](https://github.com/pwngh/economy-lab) - The ledger underneath, one line away when you need pools, sweeps, or the proof surface

## License

This project is yours. The packages it installs are MIT.
