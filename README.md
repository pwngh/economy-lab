# economy-lab

A provably-solvent credits economy: wallets, payouts, subscriptions, and a marketplace, on one double-entry ledger.

[![ci](https://github.com/pwngh/economy-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/pwngh/economy-lab/actions/workflows/ci.yml)
[![runtime deps](https://img.shields.io/badge/runtime_deps-0-3fb950)](test/manifest.test.ts)
![node](https://img.shields.io/badge/node-%E2%89%A522.18-1f6feb)
![license](https://img.shields.io/badge/license-MIT-1f6feb)

**On this page**

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Guarantees](#guarantees)
- [Ecosystem](#ecosystem)
- [Run it](#run-it)
- [Performance](#performance)
- [Documentation](#documentation)

---

> Read the full documentation at [economy-lab-docs.pages.dev](https://economy-lab-docs.pages.dev/economy/), or try the [live console](https://economy-lab-docs.pages.dev/console/).

## Highlights

- **Zero runtime dependencies** — pure TypeScript; the whole economy runs in-memory with no infrastructure.
- **Provably solvent** — `read.prove()` checks every solvency and integrity invariant; `make prove` and `make fuzz` surface any leak or drift.
- **Tamper-evident by construction** — every balance folds from an append-only, hash-chained, double-entry log under signed Merkle checkpoints.
- **Five backends** — in-memory, Postgres, MySQL, Redis, and SQS run identical logic, pinned by a single conformance suite.
- **Safe by default** — `submit` returns an `Outcome` and never throws for a "no"; every request is idempotent.
- **Ops supervisor built in** — the `./ops` entry point watches the meter/logger ports for twelve incident signatures, remediates under guardrails, and writes a hash-chained audit trail; leaving it out of the composition is the off switch.

## Quick start

Build an `Economy`, drive it through a single `submit`, and read derived state through `read`.
`createEconomy()` with no arguments wires a complete in-memory build — the store, a dev signer,
a dev rate table, a flat fee policy, and an in-memory processor — so there is nothing to configure:

```ts
import { createEconomy, topUp, toAmount, spendable } from '@pwngh/economy-lab';

const economy = await createEconomy();

// Credit a wallet after a card charge clears.
const outcome = await economy.submit(
  topUp({
    idempotencyKey: 'ord_ada_1',
    actor: { kind: 'system', service: 'payments' },
    userId: 'usr_ada',
    amount: toAmount('CREDIT', 5_000n),
    source: 'card',
  }),
);
outcome.status; // 'committed'

const balance = await economy.read.balance(spendable('usr_ada'));
balance.minor; // 5_000n — 50.00 CREDIT in minor units

const report = await economy.read.prove(); // every solvency & integrity invariant
report.conserved; // true

await economy.close();
```

## Architecture

```mermaid
flowchart TB
    subgraph sync["request path, synchronous"]
        Client(["`**submit(operation)**`"]):::entry
        Ops["`**Operations**
        validate, authorize, post`"]:::proc
        Client --> Ops
    end

    Ledger[("`**Ledger**
    the book of record
    append-only, hash-chained, double-entry`")]:::truth
    Reads["`**Projections**
    balances, statements, derived`"]:::derived
    Outbox[["`**Outbox**
    domain events`"]]:::evt
    Worker{{"`**Worker**, asynchronous
    payouts, subscriptions, fees, checkpoints, relay, inbox`"}}:::worker

    Ops -- "debit = credit" --> Ledger
    Ledger -- "re-folded on read" --> Reads
    Ledger -- "same transaction" --> Outbox
    Worker -. "submit, sweep, checkpoint, apply" .-> Ledger

    classDef entry fill:#ffffff,stroke:#1f6feb,stroke-width:1.5px,color:#1f2328;
    classDef proc fill:#f6f8fa,stroke:#57606a,stroke-width:1px,color:#1f2328;
    classDef truth fill:#1f6feb,stroke:#0b4fc4,stroke-width:2px,color:#ffffff;
    classDef derived fill:#eaf6ec,stroke:#3fb950,stroke-width:1.5px,color:#1f2328;
    classDef evt fill:#f3eefb,stroke:#8957e5,stroke-width:1.5px,color:#1f2328;
    classDef worker fill:#f3eefb,stroke:#8957e5,stroke-width:1.5px,color:#1f2328;
    style sync fill:#f0f6ff,stroke:#1f6feb,stroke-width:1px,color:#57606a;
```

The same logic runs in-memory and on Postgres or MySQL through swappable **engines** (databases that
enforce the invariants natively) and **adapters** (pluggable cache and event transports). One
conformance suite holds them to identical behavior.

## Guarantees

| Capability                   | Where                                                                                                          | What it guarantees                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Double-entry ledger          | [ledger.ts](src/ledger.ts)                                                                                     | A posting is rejected unless its debit and credit lines net to zero per currency; a balance is the sum of its lines.                   |
| Tamper-evident history       | [chain.ts](src/chain.ts), [integrity.ts](src/integrity.ts)                                                     | Each posting is hash-chained per account; a signed Merkle checkpoint anchors the whole ledger; `proveChain` locates any altered entry. |
| Idempotent requests + outbox | [economy.ts](src/economy.ts), [worker/relay.ts](src/worker/relay.ts)                                           | A retried request runs once: key, postings, and outbound event all commit in one transaction; duplicates replay.                       |
| Marketplace + fee policy     | [operations/spend.ts](src/operations/spend.ts), [pricing.ts](src/pricing.ts)                                   | A sale charges the buyer and pays the sellers in one balanced transaction; shares sum to 100%; the fee is injected policy.             |
| Payout saga + retries        | [operations/requestPayout.ts](src/operations/requestPayout.ts), [worker/payouts.ts](src/worker/payouts.ts)     | The worker submits a payout; the settlement webhook settles it once (deduped); a stuck payout re-drives then reverses.                 |
| Recurring subscriptions      | [operations/subscribe.ts](src/operations/subscribe.ts), [worker/subscriptions.ts](src/worker/subscriptions.ts) | Each period bills once; an underfunded renewal lapses instead of overdrawing.                                                          |
| Refunds & clawback           | [operations/refund.ts](src/operations/refund.ts), [operations/clawback.ts](src/operations/clawback.ts)         | A reversal restores each account the sale touched, booking any uncollectable remainder to a receivable.                                |
| Settlement maturity gate     | [maturity.ts](src/maturity.ts)                                                                                 | Payouts release only funds settled past the chargeback window; fresh credits are held back until they mature.                          |
| Spend-velocity risk gate     | [trust.ts](src/trust.ts)                                                                                       | Recent spend is summed over a sliding window and checked against a limit before any money moves.                                       |
| Swappable storage            | [engines/](src/engines), [adapters/](src/adapters)                                                             | The same logic runs in-memory and on Postgres, MySQL, Redis, and SQS; one conformance suite runs against every backend.                |

`make prove` and `make fuzz` attack these invariants after every operation and across every backend.

## Ecosystem

One sibling package composes around the ledger at runtime, behind a stable seam — the lab runs unchanged without it. See [the packages](https://economy-lab-docs.pages.dev/economy/ports/packages/) for where everything plugs in.

- **[@pwngh/economy-edge](https://github.com/pwngh/economy-edge)** — the runtime sibling: a real payout rail (Tilia) behind the same `Processor` port; an optional peer the lab composes without.

Two more packages serve the ledger without composing as siblings. **[@pwngh/money](https://github.com/pwngh/money)** is vendored into `src/` as the ledger's arithmetic, pinned by embedded conformance vectors — each boot proves the live database computes the same semantics before any posting trusts it. **[@pwngh/taskq](https://github.com/pwngh/taskq)** is an optional relay backend: with `TASKQ=1` the outbox relay rides taskq's task table beside the ledger, one at-least-once task per event, keyed by event id. The ops supervisor is not a package at all: it ships built in as the `./ops` entry point.

## Run it

```bash
make dev         # local HTTP server — in-memory, dev secrets, hot reload; zero setup
make start       # HTTP service against the configured environment
make worker      # background sweep loop
make test        # the full suite, zero infra, all in-memory
make check       # typecheck + eslint + prettier + test + golden trace (the CI gate)
make demo        # compose an economy and run a sample money flow
make prove       # randomized invariant proof; exits non-zero on any leak or drift
make fuzz        # cross-backend differential — every backend must produce identical results
make db-clean    # drop the orphaned throwaway namespaces a killed run left behind
```

The bundled host process runs as an HTTP service (`POST /submit`, `POST /webhooks/:provider`, plus
`/healthz` and `/readyz`) and a background worker (ten sweeps on an interval). Every backend is
selected by an environment variable.

## Performance

`make bench` measures `submit` throughput per backend and integrity cost as the ledger grows. In
memory it runs tens of thousands of submits per second; on Postgres or MySQL each submit is its own
transaction, so throughput is commit-bound (hundreds per second). Those are the general-path
numbers: where a workload allows it, instance netting and the entitlement bitset remove the
transaction and the round-trip respectively, which is worth orders of magnitude on the SQL
backends. See [Performance](https://economy-lab-docs.pages.dev/economy/reference/performance/) for
the measured tables and how to read them.

## Apps

- [apps/console](apps/console) — a demo admin UI driven by the live engine: accounts, the ledger
  feed, the payout board, and an integrity page, with a simulation panel to advance time and run
  the background jobs. [Try it live](https://economy-lab-docs.pages.dev/console/).
- [apps/docs](apps/docs) — the source of the [documentation site](https://economy-lab-docs.pages.dev/economy/).

## Documentation

- [The Economy surface](https://economy-lab-docs.pages.dev/economy/reference/the-economy/) — the whole `submit` / `read` / `close` API.
- [The proof](https://economy-lab-docs.pages.dev/economy/concepts/the-proof/) — how `make prove` and `make fuzz` attack the invariants.
- [HTTP service](https://economy-lab-docs.pages.dev/economy/reference/http-service/) — `POST /submit`, webhooks, and health checks.
- [Background worker](https://economy-lab-docs.pages.dev/economy/reference/background-worker/) — the ten sweeps and how they run.
- [Configuration](https://economy-lab-docs.pages.dev/economy/reference/configuration/) — every environment variable and backend selector.

## License

MIT — see [LICENSE.md](LICENSE.md).
