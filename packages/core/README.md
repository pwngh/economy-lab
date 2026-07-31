# core

`createApp` turns one `economy.app.ts` file into a running economy: a ledger, a Fetch handler, and
a background worker, wired from the named exports that file happens to have. The file is the
contract; this package is what reads it.

## Features

- **One file, named exports only** - Ten seams (`policy`, `catalog`, `authenticate`, `providers`, `worker`, `ports`, `instances`, `flags`, `after`, `routes`), every one optional, none positional
- **Refusals name the fix** - An unknown export, a default export, or a typo'd event refuses at boot with the file, the export, and the edit that clears it
- **Nothing starts on construction** - `createApp` builds; `listen()` binds and starts the background half; `close()` unwinds in the reverse order and is idempotent
- **Ownership follows creation** - `close()` releases the ports `createApp` opened; a `portsBag` you supplied stays yours to close
- **A compile you can read** - `compileEconomy` renders the module and environment as one plan: seams, routes, every knob with where its value came from, and the preflight verdict
- **Ports are overrides, not a bag** - Name one slot and the rest stay as the environment opened them
- **Re-exports, never redefinitions** - Every ledger symbol reachable from here is the same function object the ledger exports, so `Amount` brands and `instanceof` survive the boundary

## Installation

```sh
npm i @pwngh/economy
```

## Usage

An application file exports seams; `createApp` reads them and hands back an app:

```ts
// economy.app.ts
import { bearerStack, devTokens } from '@pwngh/economy/auth';

export let authenticate = bearerStack(devTokens.loopbackOnly());
export let policy = { velocityLimitMinor: 10_000_000n };
export let worker = { intervalMs: 5_000 };
```

```ts
import { createApp } from '@pwngh/economy/app';
import * as definition from './economy.app.ts';

let app = await createApp(definition);

app.module.exports; // [ 'authenticate', 'policy', 'worker' ]
app.worker; // the background half: constructed, and idle until asked

await app.listen(3000); // { port: 3000 } — binds, then starts the worker
await app.close(); // http, timers, in-flight sweeps, lanes, then the ports it opened
```

Nothing ticks before `listen()`. A worker-role process that binds no port calls `startWorker()`
instead, and a process built with `{ worker: false }` binds without a background half at all.

The last step releases the ports — the database pool, a Redis cache, an SQS client — which is why
a script that closes its app exits instead of hanging. It releases only the ports this app opened.
Hand `createApp` a `portsBag` and the bag stays open: you built it, you close it, with
`createEconomy(bag).close()` or by hand.

`app.handler` is a Fetch handler, so a runtime that speaks Fetch hosts the same app directly.
Express reaches it through `@pwngh/economy/adapters/express` and Fastify through
`@pwngh/economy/adapters/fastify`. Reading it without an
`authenticate` posture throws `ECONOMY_MODULE.AUTH_POSTURE`: in-process use needs no posture, a
network face does.

### Operations

The money vocabulary is one subpath — the fourteen operation constructors, plus the names that
read an outcome:

```ts
import {
  topUp,
  idempotencyKey,
  isRejection,
  requireSuccess,
} from '@pwngh/economy/ops';
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
requireSuccess(outcome).transaction.id; // 'txn_0f8c3a41-6d52-4b90-9c17-2e5a8b4d7f03'
```

A rejection is data, not an exception: `submit` answers with an outcome and never throws for a no.
`credits` and `usd` come from `@pwngh/economy-money`, which builds amounts. This subpath builds
operations.

### Routes

The `routes` seam mounts URL-addressed handlers ahead of the ledger's own. A handler returns a
`Response` to answer directly, or an operation draft to put through the one write door — stamped
with the authenticated principal and keyed from the caller's `idempotency-key` header:

```ts
import type { RouteHandler } from '@pwngh/economy/app';
import { credits } from '@pwngh/economy/money';

export let routes = {
  'POST /checkout': (async ({ request, principal }) => {
    if (principal?.kind !== 'user')
      return new Response('users buy things', { status: 403 });
    let { sku } = await request.json();
    return {
      kind: 'spend',
      orderId: crypto.randomUUID(),
      sku,
      price: credits(120),
    };
  }) satisfies RouteHandler,
};
```

A key that collides with `/submit`, `/v1/*`, `/healthz`, `/readyz`, `/webhooks/*`, or
`/instances/*` refuses at boot rather than quietly shadowing the route it would have hidden.

### The contract

`@pwngh/economy-core/module` is the subpath tooling reads: the seam types, the resolver, the
compile, and the boot errors. Nothing there constructs or serves — it is what `economy check`, the
framework adapters, and the test harness all speak.

```ts
import {
  resolveEconomyModule,
  compileEconomy,
  KNOWN_EXPORTS,
} from '@pwngh/economy/module';
import * as definition from './economy.app.ts';

KNOWN_EXPORTS.length; // 10, the whole seam roster

let module = resolveEconomyModule(definition, 'economy.app.ts');

module.exports; // [ 'authenticate', 'policy', 'worker' ]

let truth = compileEconomy(definition, process.env);

for (let row of truth.policy) {
  console.log(`${row.key} = ${row.value} (${row.source})`); // freshnessWindowMs = 300000 (default)
}
```

`truth` is what the module and its environment resolve to: the file and its exports, which seams
are present, the posture, every policy row and knob, the adapters in force, the routes,
capabilities, preflight issues, lints, and the desugar.

Two of those fields carry provenance. A policy row's `source` is `module`, `env`, or `default`, so
a value in force always traces back to whoever set it. A route's `source` is `module` for the ones
your file declares and `product` for the ones every economy mounts. `economy check` and
`economy routes` are projections of this one structure — there is no plan file and no hashes.

Every boot refusal is an `EconomyModuleError` carrying the file, the export, and the fix. A typo is
the ordinary case:

```ts
// economy.app.ts
export let polciy = { velocityLimitMinor: 10_000_000n };

// ECONOMY_MODULE.UNKNOWN_EXPORT — economy.app.ts, export `polciy`: rename it to `policy`.
```

### One ledger instance

Every symbol this package re-exports is the ledger's own function object, never a copy. A tree that
hoists two `@pwngh/economy-lab` versions breaks `instanceof` and the `Amount` brand across the
boundary, so keep one resolvable ledger — the identity test here is what catches a second one.

The escape hatch is one line rather than a rewrite. `boot`, `openPorts`, `memoryPorts`,
`createEconomy`, `createServer`, `createWorker`, and `handleWebhook` are deliberately not
re-exported: the day you need one, add `@pwngh/economy-lab` to `package.json` and import it from
there. Same symbols, same semantics.

## Related Packages

- [`@pwngh/economy`](../economy) — one install for every package here, and the `economy` command
- [`@pwngh/economy-auth`](../auth) — the `authenticate` seam: bearer resolvers, dev tokens, actors
- [`@pwngh/economy-money`](../money) — `credits`, `usd`, and the typed face over a wire amount
- [`@pwngh/economy-cli`](../cli) — `economy dev | serve | worker | check | routes`
- [`@pwngh/economy-test`](../test) — `openTestEconomy`, the same app over deterministic ports
- [`@pwngh/economy-adapters`](../adapters) — mount `app.handler` on Express or Fastify; Bun, Cloudflare Workers, Hono and Next.js take it as it is
- [`@pwngh/economy-lab`](https://github.com/pwngh/economy-lab) — the ledger underneath: accounts, sweeps, ports, proofs

## License

[MIT](../../LICENSE.md)
