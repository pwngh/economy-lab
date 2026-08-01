# adapters

Framework mounts for [`@pwngh/economy`](../economy). Each one is transport only — it hands
your framework's request to the same Fetch handler and returns its response, with no auth
logic, no money, and never a second conversion layer.

## Features

- **One subpath per framework that needs one:** Express and Fastify, each importable on its
  own. Both convert a Node `req`/`res` pair to a Fetch `Request` and back; a runtime that
  already speaks Fetch has nothing to convert and gets a demo instead of a package.
- **Mounting an app runs it:** the mount starts the background half — payout sagas, the outbox
  relay, subscription billing, every sweep — and hands back the `close()` that ends it.
- **The host keeps its own application:** the mount answers the paths the app declares and
  hands every other request straight on, body unread, so routes registered after it still run
  under the host's own parser.
- **Raw bytes survive:** every adapter ships only after a smoke test proves a signed webhook's
  exact bytes reach the verifier through that framework's own body pipeline.
- **No framework dependency:** Express and Fastify are yours. The one dependency here is
  `@pwngh/economy-core`.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

```ts
import { economyExpress } from '@pwngh/economy/adapters/express';

const economy = economyExpress(app);
server.use(economy); // first, so raw bytes reach it and webhook signatures verify
server.use(express.json()); // your parser, on your routes, unchanged
server.get('/orders', myOwnHandler); // still runs: the mount is not terminal

await economy.close(); // on shutdown: the face, the timers, the in-flight sweep, the store
```

```ts
import { economyFastify } from '@pwngh/economy/adapters/fastify';

const economy = economyFastify(app);
await server.register(economy); // the plugin keeps raw bytes in its encapsulation
```

### The background half

Mounting the face alone leaves the economy behind it stopped: sagas open and never poll, the
outbox never relays, and nothing reports it. So a mount that is handed a whole app starts the
background half and returns the lifecycle it owns. Hand it a bare
`(request) => Promise<Response>` instead and it starts nothing and returns no `close` — you
kept the app, so the lifecycle is still yours. A bare handler also declares no routes, so that
mount answers every path; give it a path of its own if the host has routes beside it.

Split the roles across processes with the opt-out:

```ts
server.use(economyExpress(app, { worker: false })); // the API process binds the face only
```

The worker role then runs elsewhere — `economy worker`, or `app.startWorker()` in a process of
its own. `startWorker()` is idempotent, so both processes calling it is safe.

### Other runtimes

Bun, Cloudflare Workers, Hono and Next.js already take a Fetch `Request`, so there is nothing
at the HTTP boundary for an adapter to convert: mount `app.handler` directly and start the
background half the way that runtime allows. One runnable file each:

| runtime            | the file                             | the background half             |
| ------------------ | ------------------------------------ | ------------------------------- |
| Bun                | [demos/bun](demos/bun)               | `app.startWorker()`             |
| Cloudflare Workers | [demos/cloudflare](demos/cloudflare) | a cron trigger, via `scheduled` |
| Hono               | [demos/hono](demos/hono)             | `app.startWorker()`             |
| Next.js            | [demos/next](demos/next)             | `app.startWorker()`             |

Workers hold no long-lived process, so nothing there can own a sweep timer — that demo runs the
worker role from its cron trigger, and says so. The Next.js demo starts the worker beside its
route exports, which holds only while the Node server stays up; a serverless deployment keeps
no process alive after the response, so there the worker role runs in a process of its own.

### Your routes and your parsers

The Express mount answers the paths the app declares — the list `economy routes` prints, the
built-in surface plus your own `routes` export — and calls `next()` for everything else without
reading the request. So the order above is the whole recipe: the economy first, then your
parser, then your routes. Fastify needs no ordering rule, because its router prefers your
specific route over the plugin's catch-all and the plugin's buffer parser stays inside its own
encapsulation.

An adapter is transport, so it cannot undo a parser that already consumed the stream. A host
that has to parse before the mount hands the economy raw bytes instead, with `express.raw`
scoped to the economy's paths — mounted unscoped it makes `req.body` a `Buffer` in every one of
the host's own handlers. A parsed-and-restringified body will not verify, because a webhook
signature covers bytes, not meaning.

## Related Packages

- [`@pwngh/economy`](../economy) — the handler these mount
- [`@pwngh/economy-cli`](../cli) — run the same handler without a framework at all

## License

[MIT](../../LICENSE.md)
