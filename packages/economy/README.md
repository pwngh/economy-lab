# economy

Build a credits economy on one double-entry ledger — wallets, payouts, subscriptions, and a
marketplace. Every piece is a door on this package, imported by name, at the same level, in
whatever combination your app needs.

## Features

- **One dependency, twenty-four doors:** each door is a one-line re-export of a package that also
  publishes on its own.
- **The `economy` command:** `dev`, `serve`, `worker`, `check` and `routes`, installed with the
  package.
- **Take only what you open:** import `economy/ops` and the React hooks never load.
- **Flat, not layered:** no door sits beneath another.
- **Generated from a manifest:** `manifest.json` is the door list, and `src/` is rebuilt from it
  rather than hand-edited.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

An application is a file of named exports plus the assembler that reads it:

```ts
import { createApp } from '@pwngh/economy/app';
import { bearerStack, devTokens } from '@pwngh/economy/auth';
import * as definition from './economy.app.ts';

let app = await createApp(definition);

await app.listen(3000); // { port: 3000 }
```

Money moves through the operation constructors, and a rejection comes back as data:

```ts
import { topUp, idempotencyKey, isRejection } from '@pwngh/economy/ops';
import { credits } from '@pwngh/economy/money';

let outcome = await app.economy.submit(
  topUp({
    idempotencyKey: idempotencyKey('shop', 'topup', 'ord_8f21'),
    userId: 'usr_4c1d9e',
    amount: credits(600), // the $5.00 pack, at 120 credits to the dollar
    source: 'stripe',
  }),
);

isRejection(outcome); // false
```

The command comes with the install, so there is nothing to add for the dev loop:

```sh
economy dev --demo   # an in-memory economy with dev tokens and a seeded arc
economy check        # the module and environment compiled to one truth pass
economy serve        # production: refuses every dev stand-in before it binds
```

### The doors

| Door                              | What it is for                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `@pwngh/economy/app`              | `createApp` and `withDev`: one module file assembled into a running app               |
| `@pwngh/economy/module`           | The module contract tooling reads: seam types, the resolver, the compile, boot errors |
| `@pwngh/economy/ops`              | The fourteen operation constructors and the names that read an outcome                |
| `@pwngh/economy/auth`             | Decide who is allowed to move money                                                   |
| `@pwngh/economy/money`            | Money, rates, and basis points as typed values                                        |
| `@pwngh/economy/money/rate`       | Converting credits to dollars and back, at a rate that carries its own id             |
| `@pwngh/economy/money/bps`        | Basis points: a fee taken off a price, a split paid across recipients                 |
| `@pwngh/economy/money/wire-value` | Reading and writing the `CREDIT:600.00` wire form itself                              |
| `@pwngh/economy/receipt`          | Tamper-evident receipts for committed transactions                                    |
| `@pwngh/economy/client`           | A typed client for a remote economy                                                   |
| `@pwngh/economy/events`           | Handle economy events with exact types                                                |
| `@pwngh/economy/webhook`          | Verify inbound provider callbacks                                                     |
| `@pwngh/economy/test`             | Run a real Economy app in tests                                                       |
| `@pwngh/economy/conformance`      | Test your own store against the contract                                              |
| `@pwngh/economy/ui`               | React hooks for an economy storefront                                                 |
| `@pwngh/economy/ui/core`          | The same reads without React, for any other view layer                                |
| `@pwngh/economy/cli`              | Run and inspect an Economy app                                                        |
| `@pwngh/economy/postgres`         | Store an economy ledger in PostgreSQL                                                 |
| `@pwngh/economy/mysql`            | Store an economy ledger in MySQL or MariaDB                                           |
| `@pwngh/economy/mysql/mariadb`    | The same store again on MariaDB's pipelining wire, a one-line swap                    |
| `@pwngh/economy/redis`            | Cache and rate limit an economy with Redis                                            |
| `@pwngh/economy/sqs`              | Deliver economy events through Amazon SQS                                             |
| `@pwngh/economy/adapters/express` | Mount a running economy on Express, raw body first                                    |
| `@pwngh/economy/adapters/fastify` | Mount on Fastify, raw bytes inside the plugin's encapsulation                         |

Every door also publishes as its own package — `@pwngh/economy/money` is `@pwngh/economy-money`.
Depend on this one to get all of them and the command; depend on a single package when that is all
you use.

### Testing

The test harness is a door like any other, so the deterministic run needs no second install:

```ts
import { openTestEconomy } from '@pwngh/economy/test';
import { credits } from '@pwngh/economy/money';
import * as definition from '../economy.app.ts';

let eco = await openTestEconomy(definition);
let ada = eco.user('ada');

await eco.fund(ada, credits(600));
(await ada.wallet()).spendable; // credits(600)

await eco.close();
```

### Mounting on your framework

`app.handler` is a Fetch handler, so every adapter is transport only — no auth logic, no money,
never a second conversion layer:

```ts
import { economyExpress } from '@pwngh/economy/adapters/express';

const economy = economyExpress(app);
server.use(economy); // first, so raw bytes reach it and webhook signatures verify
server.use(express.json()); // your parser, on your routes, unchanged
```

The mount answers the paths the app declares and hands every other request on untouched, so the
routes and parsers your application already has keep working.

The mount takes the whole app, so it starts the background half your host would otherwise leave
stopped, and `economy.close()` ends it. A process that only serves the face passes
`{ worker: false }` and runs `app.startWorker()` elsewhere.

An adapter ships only after its smoke test proves a signed webhook's raw bytes survive that
framework's own body pipeline. A runtime that already takes a Fetch `Request` — Bun, Cloudflare
Workers, Hono, Next.js — needs no adapter at all: mount `app.handler` and start the background
half yourself, as the demos in [`@pwngh/economy-adapters`](../adapters) show.

### Reaching the ledger

The doors cover what an application writes. The ledger underneath — pools, sweep internals, store
engines, the proof surface — is `@pwngh/economy-lab`, and it is one line away: add it to
`package.json` and import from it. The symbols are the same objects these doors re-export, so
nothing changes meaning on the way.

## Related Packages

Every door is one of these, and each publishes on its own line. Depend on this package to get
all of them and the command; depend on one directly when it is all you use.

- [`@pwngh/economy-core`](../core) — behind `economy/app`, `economy/module`, `economy/ops`: `createApp`, the module contract, the operation constructors
- [`@pwngh/economy-auth`](../auth) — behind `economy/auth`: bearer resolvers, JWKS, API keys, dev tokens, actors
- [`@pwngh/economy-money`](../money) — behind `economy/money`: `credits`, `usd`, and the typed face over a wire amount
- [`@pwngh/economy-receipt`](../receipt) — behind `economy/receipt`: a signed, chain-bound record of one transaction
- [`@pwngh/economy-conformance`](../conformance) — behind `economy/conformance`: the suites an implementation is held to
- [`@pwngh/economy-client`](../client) — behind `economy/client`: the typed `/v1` HTTP client
- [`@pwngh/economy-events`](../events) — behind `economy/events`: the event roster and its narrowing guards
- [`@pwngh/economy-webhook`](../webhook) — behind `economy/webhook`: signing and verifying a provider callback
- [`@pwngh/economy-test`](../test) — behind `economy/test`: `openTestEconomy`, over deterministic ports and personas
- [`@pwngh/economy-ui`](../ui) — behind `economy/ui` and `economy/ui/core`: the storefront reads, with React and without
- [`@pwngh/economy-cli`](../cli) — behind `economy/cli`: the `economy` verbs as functions, and the command this package installs
- [`@pwngh/economy-postgres`](../postgres) — behind `economy/postgres`: the ledger's store in PostgreSQL
- [`@pwngh/economy-mysql`](../mysql) — behind `economy/mysql` and `economy/mysql/mariadb`: the same store on either wire
- [`@pwngh/economy-redis`](../redis) — behind `economy/redis`: the read-through cache and the edge rate limiter
- [`@pwngh/economy-sqs`](../sqs) — behind `economy/sqs`: committed events delivered to Amazon SQS
- [`@pwngh/economy-adapters`](../adapters) — behind the two `economy/adapters/…` doors: express, fastify. Bun, Cloudflare Workers, Hono and Next.js take the Fetch handler as it is, and have a runnable demo each
- [`@pwngh/economy-lab`](https://github.com/pwngh/economy-lab) — not behind a door: the ledger underneath, one line away when you need it

## License

[MIT](../../LICENSE.md)
