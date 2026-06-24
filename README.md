<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" width="96" alt="economy-lab">
  </picture>
</p>

<h1 align="center" style="margin-top: -25px;">economy-lab</h4>

<p align="center">
  <em>A provably-solvent credits economy — wallets, payouts, subscriptions, and a marketplace, on one double-entry ledger.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-553_passing-3fb950" alt="tests">
  <img src="https://img.shields.io/badge/runtime_deps-0-3fb950" alt="runtime deps">
  <img src="https://img.shields.io/badge/node-%E2%89%A522.18-1f6feb" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-1f6feb" alt="license">
</p>

<p align="center">
  <a href="#architecture">Architecture</a> ·
  <a href="#the-economy-surface">Economy surface</a> ·
  <a href="#prove-it-yourself">Prove it</a> ·
  <a href="#how-its-verified">How it's verified</a> ·
  <a href="#what-it-demonstrates">What it demonstrates</a> ·
  <a href="#run-it">Run it</a>
</p>

A small, runnable lab for the application layer of a credits economy: the backend behind
how users transact and creators earn — **wallets, payouts, subscriptions, digital
ownership, and a marketplace** — where correctness, auditability, reliability, and
compliance are non-negotiable.

A money transmitter provides the regulated plumbing (KYC, AML, sanctions screening, payout
rails). This is the layer on top: wallets, entitlements, marketplace logic, and the
invariants that hold them together.

It runs entirely in memory with zero infrastructure and zero runtime dependencies
(`make test`). The same logic runs on Postgres, MySQL, Redis, and SQS through swappable
engines and adapters, with one conformance suite against each.

It is a **lab**, not a deployable money system. The ledger invariants are enforced to a
production standard — pushed down into the database and proven by an adversarial suite that
attacks the tables directly rather than trusting the app — while the operational edges (the
payout provider, FX rates, schema migrations, concurrency at scale) are deliberately stubbed
or simplified. The subject of study is the application layer and the invariants that hold it
together, not the rails underneath. (So, e.g., `db:migrate` resets by dropping the schema —
right for a throwaway database, never for one holding real money.)

## Architecture

Balances are not stored and mutated; they are **derived**. Every economic action becomes a
balanced double-entry posting in an append-only, hash-chained ledger — the book of record —
and balances and statements are projections folded back from those postings, re-derivable at
any time. The slow, recurring work runs off the request path in a background worker.

```mermaid
flowchart TB
    subgraph sync["request path · synchronous"]
        Client(["`**submit(operation)**`"]):::entry
        Ops["`**Operations**
        validate · authorize · post`"]:::proc
        Client --> Ops
    end

    Ledger[("`**Ledger**
    the book of record
    append-only · hash-chained · double-entry`")]:::truth
    Reads["`**Projections**
    balances · statements · derived`"]:::derived
    Outbox[["`**Outbox**
    domain events`"]]:::evt
    Worker{{"`**Worker** · asynchronous
    payouts · subscriptions · fees · checkpoints · relay`"}}:::worker

    Ops -- "debit = credit" --> Ledger
    Ledger -- "re-folded on read" --> Reads
    Ledger -- "same transaction" --> Outbox
    Worker -. "settle · sweep · checkpoint" .-> Ledger

    classDef entry fill:#ffffff,stroke:#1f6feb,stroke-width:1.5px,color:#1f2328;
    classDef proc fill:#f6f8fa,stroke:#57606a,stroke-width:1px,color:#1f2328;
    classDef truth fill:#1f6feb,stroke:#0b4fc4,stroke-width:2px,color:#ffffff;
    classDef derived fill:#eaf6ec,stroke:#3fb950,stroke-width:1.5px,color:#1f2328;
    classDef evt fill:#f3eefb,stroke:#8957e5,stroke-width:1.5px,color:#1f2328;
    classDef worker fill:#f3eefb,stroke:#8957e5,stroke-width:1.5px,color:#1f2328;
    style sync fill:#f0f6ff,stroke:#1f6feb,stroke-width:1px,color:#57606a;
```

The same logic runs in-memory and on Postgres or MySQL through swappable **engines**
(databases that enforce the invariants natively) and **adapters** (pluggable cache and event
transports) — one conformance suite holds them to identical behavior (below).

## The economy surface

You build an economy, then drive it through a single `submit` entry point. The in-memory
build needs no infrastructure; `compose` instead picks adapters from the environment (see
[Configuration](#configuration)). Either way you supply the four external integrations — a
`signer`, a payout `processor`, an FX `rates` source, and a fee `pricing` policy:

```ts
import { compose } from './src/index.ts';

const economy = await compose(process.env, {
  signer,
  processor,
  rates,
  pricing,
});

const outcome = await economy.submit(operation); // do one thing
const balance = await economy.read.balance(account); // read a balance
const report = await economy.read.prove(); // check every invariant
await economy.close();
```

`submit` takes one `Operation` — a tagged union of everything the economy can do:

- **money** — `topUp`, `spend` (a marketplace sale that splits the price buyer → sellers
  → platform fee; pass `giftTo` to gift the item — the buyer pays, the recipient receives
  ownership, matching VRChat's `isGift` purchase flag), `refund`, `clawback`
- **payouts** — `requestPayout` (cash earned credits out through a provider), `reversePayout`
  (operator-only: undo a reserved payout before it pays out real money)
- **subscriptions** — `subscribe`, `cancelSubscription`
- **ownership** — `grantEntitlement`, `revokeEntitlement`
- **promotions** — `grantPromo`
- **operator** — `adjust`, `reverse` (manual corrections an operator runs by hand, fully
  audited; normal users can't call them)

`read` exposes `balance`, `statement` (one account's history), and `prove` (the integrity
check below). The slower, recurring work — settling payouts, billing renewals, expiring
promo grants, sweeping fees, relaying events — runs in a separate
[background worker](#background-worker), not on the request path.

### Building values

Amounts are exact integers — a `bigint` of minor units (cents for USD, 1 for a credit), so
nothing rounds. Build one with `toAmount('CREDIT', 5000n)` or `decodeAmount('50.00',
'CREDIT')` from [money.ts](src/money.ts). Account ids come from `spendable(userId)`,
`earned(userId)`, `promo(userId)`, and the house `SYSTEM.*` accounts in
[accounts.ts](src/accounts.ts). Every operation also carries an `idempotencyKey` (so a
retried request runs at most once) and an `actor` (who is asking: a `user`, a `system`
service, or an `operator`).

Entity ids use VRChat's `prefix_<uuid>` form — `usr_…` for a user, `prod_…` for a
marketplace listing, `pur_…` for a purchase. `idempotencyKey` is any string the caller
chooses (often a plain UUID); a retry reuses it.

### Handling the result

`submit` returns an `Outcome` — it never throws for an ordinary "no":

```ts
const outcome = await economy.submit(op);
switch (outcome.status) {
  case 'committed':
    outcome.transaction; // the posted legs and the per-account hash-chain links
    break;
  case 'duplicate':
    outcome.transaction; // a retry of a key already used — the original ran exactly once
    break;
  case 'rejected':
    outcome.reason; // a clean decline: 'INSUFFICIENT_FUNDS' | 'RISK_DENIED' | 'FUNDS_IMMATURE' | …
    break;
}
```

Only a malformed request or a genuine fault (bad signature, currency mismatch, a provider
that's down) is thrown.

## A complete flow

A buyer tops up, buys from two creators, and a creator cashes out — then the books are
proven to still balance. A fully-wired runnable version is
[scripts/compose-demo.ts](scripts/compose-demo.ts), which `make demo` runs.

```ts
import { compose } from './src/index.ts';
import { decodeAmount } from './src/money.ts';
import { spendable, earned, SYSTEM } from './src/accounts.ts';

const economy = await compose(process.env, {
  signer,
  processor,
  rates,
  pricing,
});

const buyer = 'usr_c1644b5b-3ca4-45b4-97c6-a2a0de70d469';
const creatorA = 'usr_2b9d5e74-1f0a-4c3b-9e8d-6a1f2c3d4e5f';
const creatorB = 'usr_7d3e1a92-8c4b-4f6d-a1e2-3b4c5d6e7f80';
const bundle = 'prod_bfbc2315-247a-44d7-bfea-5237f8d56cb4'; // a marketplace listing

// 1. The platform credits the buyer's wallet with 50.00 after their card charge clears
//    (a top-up is initiated by a trusted service, not the user themselves).
await economy.submit({
  kind: 'topUp',
  idempotencyKey: '550e8400-e29b-41d4-a716-446655440001',
  actor: { kind: 'system', service: 'payments' },
  userId: buyer,
  amount: decodeAmount('50.00', 'CREDIT'),
  source: 'card',
});

// 2. The buyer purchases a 12.00 bundle; the price splits 60/40 between two creators and
//    the platform keeps its fee. The buyer's promo balance is drawn first, then spendable.
await economy.submit({
  kind: 'spend',
  idempotencyKey: '550e8400-e29b-41d4-a716-446655440002',
  actor: { kind: 'user', userId: buyer },
  orderId: 'pur_f0446b91-e0f7-403e-8932-609d5057898c',
  buyerId: buyer,
  sku: bundle,
  price: decodeAmount('12.00', 'CREDIT'),
  recipients: [
    { sellerId: creatorA, shareBps: 6_000 },
    { sellerId: creatorB, shareBps: 4_000 },
  ],
});

// 3. See where the money landed.
await economy.read.balance(spendable(buyer)); // 38.00 left
await economy.read.balance(earned(creatorA)); // ~60% of the net
await economy.read.balance(SYSTEM.REVENUE); // the platform fee

// 4. A creator requests a payout. This reserves the earned credits and opens a payout
//    saga — it does not pay out synchronously. It's gated by a minimum balance and a
//    settlement window, so a brand-new or tiny balance comes back 'rejected'
//    (BELOW_MINIMUM / FUNDS_IMMATURE) rather than leaving early.
await economy.submit({
  kind: 'requestPayout',
  idempotencyKey: '550e8400-e29b-41d4-a716-446655440005',
  actor: { kind: 'user', userId: creatorA },
  userId: creatorA,
  amount: decodeAmount('20.00', 'CREDIT'),
});

// 5. Whatever happened above, the books still balance.
(await economy.read.prove()).conserved; // true
```

The reserved payout is finished off the request path by the [background
worker](#background-worker): it walks the saga `RESERVED → SUBMITTED` (calls your processor,
converting credits to USD at the current rate) `→ SETTLED`. A fresh payout settles after two
sweeps.

## Prove it yourself

`make prove` drives the real economy through seeded-random operations — top-ups,
purchases, gifts, refunds, subscriptions — and re-checks the money invariants after
_every single one_. It runs the same program against each storage backend it can reach
(in-memory, the in-process HTTP adapter, Postgres if `DATABASE_URL` is set, and MySQL if
`MYSQL_TEST_URL` is set), so a
backend that drifts from the others is caught. `make fuzz` goes further: it asserts
that every backend produces _identical_ balances, chain heads, and proof reports for the
same inputs. Both exit non-zero on the first violation, so they double as CI gates.

The proof checks five properties, after every committed operation (these are the five
flags `read.prove()` returns):

- **conserved** — every credit is matched by an equal debit, so value is never minted or
  lost; the books add up to zero in each currency.
- **no overdraft** — no user account is ever below zero; an overdraft is rejected up
  front, never reconciled after the fact.
- **backed** — every credit a user holds is covered by real money set aside in a
  segregated trust account and never spent on revenue (the books stay _solvent_).
- **chain intact** — each posting is hashed together with the one before it, so any
  rewrite of history is detectable; a periodic signed checkpoint catches a wholesale
  re-seal.
- **consistent** — every account's cached balance equals the sum of its posted lines, so
  the derived read model can't silently drift from the ledger it summarizes.

The same proof engine also runs inside `make test` as a property test over several seeds.

## How it's verified

Correctness here is attacked, not asserted — four independent layers:

- **Invariants live in the database, not the app.** Conservation, no-overdraft, chain
  continuity, and balance integrity are pushed down into Postgres triggers and MySQL's
  least-privilege stored procedures. The app's matching checks are a courtesy that returns a
  kind error first; the engine is the wall.
- **An adversarial suite attacks the tables directly.** Rather than trust the app's own
  writes, the tests write violating rows straight into the database and assert the engine
  rejects them — a guard only the application performs isn't enforcement.
- **Concurrency is checked against a model.** A linearizability harness oversubscribes
  concurrent spends with the in-memory store as an executable reference; every interleaving
  the engine commits under contention must replay serially to identical balances.
- **Every backend must agree.** One conformance suite runs against all four backends
  (in-memory, in-process HTTP, Postgres, MySQL), and `make fuzz` asserts they produce
  byte-identical balances, chain heads, and proof reports for the same seeded inputs — so a
  backend that drifts from the reference is caught at once.

## What it demonstrates

| Capability                   | Where                                                                                                          | What it guarantees                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Double-entry ledger          | [ledger.ts](src/ledger.ts)                                                                                     | A posting is rejected unless its debit and credit lines net to zero per currency; an account's balance is the sum of its lines.               |
| Tamper-evident history       | [chain.ts](src/chain.ts), [integrity.ts](src/integrity.ts)                                                     | Each posting is hash-chained to the previous one per account; `proveChain` recomputes the chain and locates any altered entry.                |
| Idempotent requests + outbox | [economy.ts](src/economy.ts), [worker/relay.ts](src/worker/relay.ts)                                           | A retried request runs once — the idempotency key, the postings, and the outbound event all commit in one transaction; duplicates replay.     |
| Marketplace + fee policy     | [operations/spend.ts](src/operations/spend.ts), [pricing.ts](src/pricing.ts)                                   | A sale charges the buyer and pays the sellers in one balanced transaction; shares must sum to 100%; the fee is injected policy, not a branch. |
| Payout saga + retries        | [operations/requestPayout.ts](src/operations/requestPayout.ts), [worker/payouts.ts](src/worker/payouts.ts)     | A provider that fails then succeeds pays once; a stuck payout re-drives on a schedule, with the credits reserved meanwhile.                   |
| Recurring subscriptions      | [operations/subscribe.ts](src/operations/subscribe.ts), [worker/subscriptions.ts](src/worker/subscriptions.ts) | Each period bills once; an underfunded renewal lapses instead of overdrawing; a due-sweep drives renewals.                                    |
| Refunds & clawback           | [operations/refund.ts](src/operations/refund.ts), [operations/clawback.ts](src/operations/clawback.ts)         | A refund reverses the exact lines the sale posted; a clawback pulls credits back, booking any shortfall to a receivable.                      |
| Settlement maturity gate     | [maturity.ts](src/maturity.ts)                                                                                 | Payouts and sweeps release only funds settled past the chargeback window; fresh credits are held back until they mature.                      |
| Spend-velocity risk gate     | [trust.ts](src/trust.ts)                                                                                       | Recent spend is summed over a sliding window and checked against a limit, producing an allow/deny decision before any money moves.            |
| Processor reconciliation     | [reconcile.ts](src/reconcile.ts)                                                                               | The ledger is matched against the payment processor's own records to surface anything present on one side but not the other.                  |
| Swappable storage            | [engines/](src/engines), [adapters/](src/adapters)                                                             | The same logic runs in-memory and on Postgres, MySQL, Redis, and SQS; one conformance suite runs against every backend.                       |

### The same flows, seen by an adversary

The money paths that pay creators are the ones bad actors probe, so the defenses read the
ledger's own postings rather than a separate system alongside it:

- **Chargeback fraud** — spend or cash out, then dispute the original charge so the
  credits are gone before the reversal lands. Defended at both ends: spend velocity and
  the payout maturity gate up front, the clawback's receivable after.
- **Cash-out gating** — only funds settled past the chargeback window can leave, so
  stolen-card value can't reach irreversible cash before the dispute arrives.

## Storage and messaging adapters

The core logic talks to a few narrow ports (a `Store`, an optional read-through `Cache`, an
optional event `Dispatcher`, a payout `Processor`). Each has interchangeable adapters,
chosen from the environment at startup — the in-memory ones need nothing, so `make test`
runs with no infrastructure. The database/queue drivers are **optional** dependencies,
imported only when the matching variable selects them.

| Adapter        | Port       | Needs               | Driver                | Selected by                        |
| -------------- | ---------- | ------------------- | --------------------- | ---------------------------------- |
| in-memory      | Store      | nothing             | —                     | `DATABASE_URL` unset (the default) |
| Postgres       | Store      | a Postgres server   | `pg`                  | `DATABASE_URL=postgres://…`        |
| MySQL          | Store      | a MySQL server      | `mysql2`              | `DATABASE_URL=mysql://…`           |
| Redis          | Cache      | a Redis server      | `ioredis`             | `REDIS_URL` (on the HTTP server)   |
| SQS            | Dispatcher | an SQS queue        | `@aws-sdk/client-sqs` | `SQS_QUEUE_URL` (wins over HTTP)   |
| HTTP           | Dispatcher | a POST endpoint     | — (`fetch`)           | `DISPATCHER_URL`                   |
| HTTP           | Store      | a `fetch` endpoint  | — (`fetch`)           | used by `prove`/tests; in-process  |
| HTTP processor | Processor  | a provider endpoint | — (`fetch`)           | `PROCESSOR_URL` (else a dev stub)  |

## Configuration

All configuration is environment variables, read once at startup; a misconfigured deploy
fails immediately rather than mid-request.

**Wiring** — picks the adapters above:

| Variable         | Selects                                                                 | Default   |
| ---------------- | ----------------------------------------------------------------------- | --------- |
| `DATABASE_URL`   | the Store: `postgres://`/`postgresql://` → Postgres, `mysql://` → MySQL | in-memory |
| `REDIS_URL`      | a read-through Redis cache (HTTP server only)                           | no cache  |
| `SQS_QUEUE_URL`  | the outbox dispatcher (SQS); takes precedence over `DISPATCHER_URL`     | none      |
| `DISPATCHER_URL` | the outbox dispatcher (HTTP POST)                                       | none      |

**Secrets and mode** — required only in production (`NODE_ENV=production`); outside it they
default to empty so local runs need nothing:

| Variable         | Purpose                                      | Default    |
| ---------------- | -------------------------------------------- | ---------- |
| `WEBHOOK_SECRET` | verifies inbound provider webhooks           | `''` (dev) |
| `SIGNING_SECRET` | signs the tamper-evident checkpoints         | `''` (dev) |
| `NODE_ENV`       | `production` makes the two secrets mandatory | —          |

**Host process** — read only by the bundled `serve`/`worker` entry point
([scripts/main.ts](scripts/main.ts)):

| Variable              | Purpose                                                         | Default     |
| --------------------- | --------------------------------------------------------------- | ----------- |
| `PORT`                | HTTP port for `serve`                                           | `3000`      |
| `WORKER_INTERVAL_MS`  | gap between `worker` sweep ticks                                | `60000`     |
| `WORKER_BATCH`        | rows processed per sweep                                        | `100`       |
| `SHUTDOWN_TIMEOUT_MS` | grace period for in-flight work on shutdown (SIGTERM/SIGINT)    | `5000` (5s) |
| `PROCESSOR_URL`       | real payout provider endpoint; unset → a stub that approves all | dev stub    |
| `PROCESSOR_API_KEY`   | bearer token sent to `PROCESSOR_URL`                            | —           |

**Policy tunables** — every business knob has a sensible default, so none are required:

| Variable                                                  | Meaning                                     | Default                |
| --------------------------------------------------------- | ------------------------------------------- | ---------------------- |
| `PLATFORM_FEE_BPS`                                        | platform fee on a sale, in basis points     | `1530` (15.3%)         |
| `PAYOUT_FEE_BPS`                                          | fee on a payout (cash-out), in basis points | `150` (1.5%)           |
| `VELOCITY_LIMIT_MINOR` / `VELOCITY_WINDOW_MS`             | spend-velocity cap and its window           | `100000` / `1h`        |
| `MATURITY_HORIZON_CARD_MS` / `_CRYPTO_MS` / `_DEFAULT_MS` | settlement window before funds can leave    | `7d` / `24h` / card    |
| `PAYOUT_MIN_EARNED_MINOR` / `PAYOUT_MIN_INTERVAL_MS`      | minimum payout and gap between payouts      | `2000000` / `24h`      |
| `MAX_PAYOUT_ATTEMPTS` / `MAX_PAYOUT_AGE_MS`               | payout retries / SLA age before dead-letter | `5` / `24h`            |
| `MAX_OUTBOX_ATTEMPTS` / `MAX_SUBSCRIPTION_ATTEMPTS`       | outbox delivery retries / renewal retries   | `10` / `10`            |
| `REPLAY_WINDOW_MS`                                        | idempotency replay window                   | `300000` (5m)          |
| `SLA_PENDING_MS` / `SLA_SUBMITTED_MS` / `SLA_DEFAULT_MS`  | payout step SLAs                            | `30s` / `120s` / `60s` |

## Run it

```bash
make dev         # local HTTP server — in-memory, dev secrets, hot reload; zero setup (see below)
make start       # HTTP service against the configured environment (see below)
make worker      # background sweep loop (see below)
make test        # the full suite, zero infra, all in-memory
make check       # typecheck + eslint + prettier + test (the CI gate)
make demo        # compose an economy from the environment and run a sample money flow
make prove       # randomized invariant proof; exits non-zero on any leak or drift
make fuzz        # cross-backend differential — every backend must produce identical results
```

### HTTP service

`make start` runs the economy as an HTTP service on `PORT` (default 3000), with the Store, cache,
and dispatcher chosen from the environment. `make dev` runs the same service forced in-memory
with dev secrets and hot reload (via `node --watch`), so a local loop needs no database and no
configured secrets. It serves `GET /healthz` and `GET /readyz` (liveness/readiness probes) plus two
write routes — everything else is a 404:

- `POST /submit` — the JSON body is one operation; the result comes back as JSON. Money
  fields travel as currency-tagged decimal strings (e.g. `"CREDIT:50.00"`), and a business
  decline returns `200` with the rejection, not an error status.
- `POST /webhooks/:provider` — the bundled purchase-webhook handler verifies the provider's
  HMAC signature and timestamp freshness, then maps a verified callback to an exactly-once
  top-up; a forged or stale callback is refused before any money moves.

```bash
PORT=3000 make start
curl -sX POST localhost:3000/submit -H 'content-type: application/json' -d '{
  "kind": "topUp",
  "idempotencyKey": "550e8400-e29b-41d4-a716-446655440001",
  "actor": { "kind": "system", "service": "payments" },
  "userId": "usr_c1644b5b-3ca4-45b4-97c6-a2a0de70d469",
  "amount": "CREDIT:50.00",
  "source": "card"
}'
```

### Background worker

`make worker` runs the recurring work that doesn't belong on the request path. It does one
sweep immediately, then repeats every `WORKER_INTERVAL_MS` (default 60s), handling up to
`WORKER_BATCH` rows per job. Each tick runs nine jobs in order, each isolated so one failing
can't stop the rest:

| Job                   | What it does                                            |
| --------------------- | ------------------------------------------------------- |
| **payouts**           | advance each due payout saga one step                   |
| **subscriptions**     | bill or lapse due renewals                              |
| **treasury**          | re-check that trust cash still backs the liability      |
| **fees**              | sweep the platform's matured fee surplus into cash      |
| **checkpoint-verify** | re-verify the last signed checkpoint against the ledger |
| **checkpoint**        | seal a fresh signed checkpoint of the ledger            |
| **relay**             | deliver pending outbox events through the dispatcher    |
| **reconcile**         | compare the ledger against the payment processor        |
| **promos**            | claw back unspent, expired promo grants                 |

`relay` and `reconcile` are no-ops when no dispatcher or reconcile feed is configured.

```bash
make worker                                     # every 60s, batch 100
WORKER_INTERVAL_MS=5000 WORKER_BATCH=500 make worker
```

### With Docker (Postgres, MySQL, Redis, SQS)

`docker compose up -d` brings up Postgres (`5432`), MySQL (`3306`), Redis (`6379`), and
LocalStack/SQS (`4566`). Point the app at them, run the schema migration first, then
`make start` or `make worker`:

```bash
docker compose up -d

# Postgres + a read-through Redis cache
export DATABASE_URL='postgres://economy:economy@localhost:5432/economy_lab'
export REDIS_URL='redis://localhost:6379'
make db-migrate
make start        # or: make worker

# …or MySQL instead
export DATABASE_URL='mysql://root:economy@localhost:3306/economy_lab'
make db-migrate && make start
```

Without Docker, any local Postgres works — `createdb economy_lab`, point `DATABASE_URL` at
it, `make db-migrate`, then `make test` (its Postgres conformance suite runs only when
`DATABASE_URL` is set, and is skipped otherwise). CI runs the gate on every push.

## License

MIT — see [LICENSE](LICENSE).
