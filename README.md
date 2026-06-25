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
  <img src="https://img.shields.io/badge/tests-554_passing-3fb950" alt="tests">
  <img src="https://img.shields.io/badge/runtime_deps-0-3fb950" alt="runtime deps">
  <img src="https://img.shields.io/badge/node-%E2%89%A522.18-1f6feb" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-1f6feb" alt="license">
</p>

<p align="center">
  <a href="#architecture">Architecture</a> ·
  <a href="#the-money-model">The money model</a> ·
  <a href="#the-economy-surface">Economy surface</a> ·
  <a href="#operations-that-live-over-time">Lifecycles</a> ·
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

## The money model

Before the API, the model. Two kinds of value move through the system:

- **Credits** — the in-app currency: what a user buys, spends in the marketplace, and earns as a
  creator. Always a whole number, never a fraction.
- **Dollars** — real money. The platform holds dollars in trust to back the credits users can spend,
  and pays dollars out to creators who cash in.

Every credit a user can spend is matched by real cash set aside in a trust account. That backing,
checked continuously, is what _provably solvent_ means.

### Two rates, and where the fee lives

Credits convert to dollars at fixed, platform-set rates, not a live market. Two of them carry the
whole model:

| Rate    | What it is                                  | Roughly                       |
| ------- | ------------------------------------------- | ----------------------------- |
| **buy** | what a user pays per credit when purchasing | ~$0.0083 (≈ 120 credits / $1) |
| **par** | a credit's backing value and cash-out floor | ~$0.005 (≈ 200 credits / $1)  |

A credit costs **more to buy than it pays back at cash-out**. That spread — about 40% in the
example rates above — is the **platform spread**: the platform's margin, funding fees, payment
processing, reserves, and operating costs. It is taken once, at purchase, and never mixed
into the cash held to back users. So a `$10` purchase becomes **1,200 credits**, of which `$6.00`
(1,200 × par) is set aside as backing and `$4.00` is the platform's to keep. Creators cash out at par,
so a credit earned is worth exactly the dollars reserved for it.

### The accounts

Every balance lives in a named account, and every operation is a balanced double-entry posting:
money moves _between_ accounts and the lines always net to zero. A user's accounts hold credits; the
platform's own "house" accounts hold its cash, its revenue, and the obligations between them.

A user has up to three accounts:

| Account     | Holds                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| `spendable` | credits bought and ready to spend — **the only balance backed by trust cash** |
| `earned`    | revenue owed to them as a seller, waiting to be paid out                      |
| `promo`     | a marketing grant that expires if unspent                                     |

The platform's house accounts (each id prefixed `platform:`):

| Account          | Cur.   | Holds                                                              |
| ---------------- | ------ | ------------------------------------------------------------------ |
| `trust_cash`     | USD    | real dollars held in trust, backing users' spendable credits       |
| `revenue_usd`    | USD    | the platform's dollar margin from the buy-vs-par spread            |
| `usd_clearing`   | USD    | mirror of cash that has cleared in or out of trust                 |
| `revenue`        | credit | platform fee income (the marketplace cut, plus rounding)           |
| `stored_value`   | credit | running tally of every credit ever issued (the offset on a top-up) |
| `payout_reserve` | credit | earned credits set aside for a payout in flight                    |
| `receivable`     | credit | a shortfall a user owes back (e.g. a clawback that went negative)  |
| `promo_float`    | credit | the offset for credits granted as promos                           |
| `opening_equity` | credit | the offset used once, to seed balances on a cold start             |

Accounts are debit- or credit-normal: a user's `spendable` rises when it's _credited_ (the platform
owes them more), while `trust_cash` rises when it's _debited_ (more cash is in). The ledger signs
each posted line accordingly, so the no-overdraft check reads every balance right-way-up.

### Following the money

The same flow the [complete example](#a-complete-flow) runs in code, watched through the accounts. A
**top-up** is where the money splits — buy `$10` of credit, and three accounts move:

```text
spendable     +1,200 credits   the user's, to spend
trust_cash    +$6.00           held in trust to back those credits
revenue_usd   +$4.00           the platform's margin, kept
```

From there a **spend** of 600 credits leaves `spendable`, split across the sellers' `earned` and the
platform's `revenue`. A **payout** sets a creator's `earned` aside in `payout_reserve`, then settles —
the credits retire and the matching dollars leave `trust_cash`.

Every step is a balanced posting, and trust cash still covers every spendable credit afterward.

### Solvency

The promise is simple: **a user can always cash out the credits they hold.** For that to be true, the
platform keeps enough real dollars in trust to redeem every spendable credit at par
(`trust_cash ≥ spendable credits × par`) and never issues a credit it hasn't backed. Picture
`trust_cash` as a safe holding users' money — one the platform isn't allowed to open to pay its own
bills.

Only spendable credits need backing. Credits a creator has _earned_ but not yet cashed out, and promo
grants, are owed in credits, not dollars — so they don't raise the cash the platform must hold.
Dollars are reserved only against money the platform is actually holding for someone.

The platform still gets paid: it sweeps its fees and margin into its own accounts — but only from the
**surplus**, the cash sitting beyond what's owed to users. The trust money is never touched.

The worker re-checks all of this every cycle, and `read.prove()` reports it as the `backed` flag. If
that flag ever flips to false, credits exist that no dollars stand behind — the quiet failure that
has sunk more than one custodian — and payouts stop until the gap is filled.

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
  ownership via an `isGift` purchase flag), `refund`, `clawback`
- **payouts** — `requestPayout` (cash earned credits out through a provider), `reversePayout`
  (system or operator: undo a reserved payout before it pays out real money)
- **subscriptions** — `subscribe`, `cancelSubscription`
- **ownership** — `grantEntitlement`, `revokeEntitlement`
- **promotions** — `grantPromo`
- **operator** — `adjust`, `reverse` (manual corrections an operator runs by hand, fully
  audited; normal users can't call them)

`read` exposes `balance`, `statement` (one account's history), `entitled` (whether a user owns a
given SKU), and `prove` (the integrity check below). The slower, recurring work — settling payouts, billing renewals, expiring
promo grants, sweeping fees, relaying events — runs in a separate
[background worker](#background-worker), not on the request path.

### Building values

Amounts are exact integers — a `bigint` of minor units (cents for USD, 1 for a credit), so
nothing rounds. Build one with `toAmount('CREDIT', 5000n)` or `decodeAmount('50.00',
'CREDIT')` from [money.ts](src/money.ts). Account ids come from `spendable(userId)`,
`earned(userId)`, `promo(userId)`, and the house `SYSTEM.*` accounts (see
[The money model](#the-money-model) for what each holds). Every operation also carries an
`idempotencyKey` (so a
retried request runs at most once) and an `actor` (who is asking: a `user`, a `system`
service, or an `operator`).

Entity ids use a typed `prefix_<uuid>` form — `usr_…` for a user, `prod_…` for a
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

### Who can do what

Every operation carries an `actor`, and an authorization gate runs _before_ any work — a denied
caller never reaches the ledger. There are three kinds of principal:

| Actor          | Who it is                        | What's theirs                                                                                               |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **`user`**     | an end user, acting for themself | spend, subscribe, request a payout, cancel a subscription — on their own accounts — and check what they own |
| **`system`**   | a trusted internal service       | the privileged automated flows: top-ups, refunds, clawbacks, promo & entitlement grants and revokes         |
| **`operator`** | a human making a manual fix      | the operator-only corrections — `adjust` and `reverse` — plus anything a `system` actor can do              |

The gate enforces two rules. **Privileged operations** — minting credits with a top-up, granting
promos, granting or revoking entitlements, refunds, clawbacks, and the manual corrections — are closed
to `user` actors outright. And a `user` **may only debit accounts they own**: the gate pulls out the accounts an
operation will _drain_ and checks each belongs to the caller, so a request can pay _into_ a seller but
never _out of_ a stranger. Operations that name a resource the gate can't see in the request — your
subscription, your payout saga — carry that ownership check inside the handler instead.

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

The reserved payout is then finished off the request path — that flow, and the other operations that
outlive their request, are the next section.

## Operations that live over time

Top-up and spend finish the instant you call them. Others can't: a payout waits on an outside
provider, a subscription bills period after period, a promo expires on a schedule. Each is modeled as
a record the [background worker](#background-worker) advances one safe step at a time — so a crash
mid-flight resumes where it left off, and a step that runs twice still counts once.

### Payouts: the saga

Cashing a creator out reaches a system the ledger doesn't control — an external payout rail that
answers in its own time — so `requestPayout` doesn't pay. It reserves the credits (`debit earned →
credit payout_reserve`) and opens a **saga**, a small record the worker drives forward one step per
sweep:

```text
RESERVED ──▶ SUBMITTED ──▶ SETTLED

RESERVED    credits locked in payout_reserve; nothing sent yet
SUBMITTED   the worker converts the reserve to USD and calls your payout rail
SETTLED     the rail confirms; the reserve clears to revenue and an equal sum
            of real dollars leaves trust_cash for the creator
```

Because each sweep advances one state, a fresh payout settles after two: one to submit, one to settle.
Three guards make that safe to re-drive. The call to your rail is **idempotent** (keyed by the saga
id), so a retried submit pays once. Each state change is a **compare-and-set**, so two workers racing
the same saga can't both settle it. And a payout that keeps failing or sits unconfirmed too long is
given up on — past `MAX_PAYOUT_ATTEMPTS` attempts or `MAX_PAYOUT_AGE_MS` of silence it fails and the
reserve returns to the creator's `earned`. An operator can force that same reversal early with
`reversePayout`, as long as the money hasn't already left.

### Subscriptions

`subscribe` charges the first period and grants the buyer an entitlement to the SKU; from there the
worker bills it. Each period it claims a one-charge-per-period key (so overlapping sweeps can't
double-bill), debits the subscriber's `spendable`, pays the seller, and pushes out the next due date.
The subscription is its own small machine:

```text
ACTIVE ──▶ LAPSED      a renewal it can't pay (or one that keeps failing) ends it;
                       the SKU entitlement is revoked in the same step
       ──▶ CANCELED    the user or an operator stops it; the current period is
                       not refunded
```

`MAX_SUBSCRIPTION_ATTEMPTS` separates a transient failure from a dead one: a failed charge is retried
a few times before the subscription lapses, and a success resets the count. The first period may draw
on promo credit; renewals come only from `spendable`.

### Promo grants

`grantPromo` drops marketing credit into a user's `promo` balance (offset against `promo_float`) with
an expiry date. The worker's promo sweep reverses whatever is **unspent** when a grant expires —
reading the live balance, so a partly-spent grant only claws back the remainder and a fully-spent one
posts nothing. Promo credit spends ahead of a user's own money and carries no maturity hold, so a
grant is usable the instant it lands.

### Corrections and ownership

The remaining operations finish synchronously, but complete the picture:

- **`refund`** undoes a sale account by account, returning each to where it stood. If a seller has
  already spent their cut, it claws back only what's left and books the rest to a **receivable** — the
  platform's IOU — so the reversal still nets to zero, then revokes the buyer's (or gift recipient's)
  entitlement.
- **`clawback`** answers a card chargeback: it un-issues the credits, recovering what the user still
  holds and booking the spent remainder to that same receivable. A refund and a chargeback for one
  order are mutually exclusive — whichever lands first wins, the other is a no-op.
- **`adjust`** and **`reverse`** are the operator's manual tools — a hand-posted correction and a full
  reversal of a past transaction — each requiring a written reason and landing in the audit trail.
- **`grantEntitlement`** and **`revokeEntitlement`** move no money at all. Ownership of a SKU is a
  record the ledger never touches, granted at purchase and revoked on refund or lapse, and read back
  through `read.entitled` — the gate that decides what a user is allowed to access.

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

### Tamper-evidence: the chain and the checkpoint

The `chain intact` flag rests on two layers. The first is a **per-account hash chain**: every posting
that touches an account is hashed together with that account's previous hash — the amount, the
counterparties, the metadata, all of it — so each entry commits to the whole history before it. Change
one old amount and its hash changes, which breaks the next link, and the next; the prover walks each
account from genesis and names the first entry that no longer re-derives. (The chain is per-account,
not per-posting: a posting that moves three accounts advances three chains by one link each.)

The second layer anchors the entire ledger at a moment. The worker periodically folds every account's
current head into a single **Merkle root** and signs it (Ed25519) into a **checkpoint** — a
`checkpoint` job seals new ones, a `checkpoint-verify` job re-checks the latest against the live ledger
every cycle. The signing key's public half is published, so anyone — an auditor holding nothing but a
saved checkpoint and that public key — can recompute the root over the ledger and verify the signature
themselves.

The two layers catch different attacks. The hash chain catches a single edited row that still balances —
the tamper the money invariants can't see, because conservation is a property of sums, not of the rows
behind them. The checkpoint catches the harder attack, a _wholesale re-seal_: rewriting history **and**
recomputing every chain so it looks intact still produces a different root than the one already signed,
and that signature can't be forged without the key. A failed verification doesn't quietly heal — it's
logged for an operator, because only a human can tell a legitimate new posting from an attack.

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

| Capability                   | Where                                                                                                          | What it guarantees                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double-entry ledger          | [ledger.ts](src/ledger.ts)                                                                                     | A posting is rejected unless its debit and credit lines net to zero per currency; an account's balance is the sum of its lines.                   |
| Tamper-evident history       | [chain.ts](src/chain.ts), [integrity.ts](src/integrity.ts)                                                     | Each posting is hash-chained to the previous one per account; `proveChain` recomputes the chain and locates any altered entry.                    |
| Idempotent requests + outbox | [economy.ts](src/economy.ts), [worker/relay.ts](src/worker/relay.ts)                                           | A retried request runs once — the idempotency key, the postings, and the outbound event all commit in one transaction; duplicates replay.         |
| Marketplace + fee policy     | [operations/spend.ts](src/operations/spend.ts), [pricing.ts](src/pricing.ts)                                   | A sale charges the buyer and pays the sellers in one balanced transaction; shares must sum to 100%; the fee is injected policy, not a branch.     |
| Payout saga + retries        | [operations/requestPayout.ts](src/operations/requestPayout.ts), [worker/payouts.ts](src/worker/payouts.ts)     | A provider that fails then succeeds pays once; a stuck payout re-drives on a schedule, with the credits reserved meanwhile.                       |
| Recurring subscriptions      | [operations/subscribe.ts](src/operations/subscribe.ts), [worker/subscriptions.ts](src/worker/subscriptions.ts) | Each period bills once; an underfunded renewal lapses instead of overdrawing; a due-sweep drives renewals.                                        |
| Refunds & clawback           | [operations/refund.ts](src/operations/refund.ts), [operations/clawback.ts](src/operations/clawback.ts)         | A refund restores each account the sale touched, booking any uncollectable remainder to a receivable; a clawback pulls credits back the same way. |
| Settlement maturity gate     | [maturity.ts](src/maturity.ts)                                                                                 | Payouts and sweeps release only funds settled past the chargeback window; fresh credits are held back until they mature.                          |
| Spend-velocity risk gate     | [trust.ts](src/trust.ts)                                                                                       | Recent spend is summed over a sliding window and checked against a limit, producing an allow/deny decision before any money moves.                |
| Processor reconciliation     | [reconcile.ts](src/reconcile.ts)                                                                               | The ledger is matched against the payment processor's own records to surface anything present on one side but not the other.                      |
| Swappable storage            | [engines/](src/engines), [adapters/](src/adapters)                                                             | The same logic runs in-memory and on Postgres, MySQL, Redis, and SQS; one conformance suite runs against every backend.                           |

### The same flows, seen by an adversary

The money paths that pay creators are the ones bad actors probe, so the defenses read the ledger's own
postings rather than a separate system bolted alongside. The classic attack is **chargeback fraud**:
top up with a stolen card, move the credits to cash or to an accomplice, then dispute the charge so
the money is gone before the reversal lands. Three mechanisms close that window, in order:

- **Maturity.** Credits are tracked as **lots** — each top-up tagged with its funding source and time
  — and spent oldest-first (FIFO), so no one can cherry-pick the settled ones. A lot can't be spent or
  cashed out until it has aged past its source's settlement window: a card top-up holds for the
  chargeback period (about a week by default), a more final source like crypto clears in a day. Fresh
  stolen-card value simply can't leave in time.
- **Velocity.** Every value-moving request is recorded against the actor and summed over a rolling
  window; past a configured ceiling the next one comes back `RISK_DENIED`. The count is written _at
  check time_ — even for denied or rolled-back attempts — so a concurrent burst can't slip several
  past a stale read, and the burst itself is a fraud signal worth keeping.
- **The receivable.** When a chargeback does land after the user has spent, `clawback` un-issues the
  credits, recovers what's still in the wallet, and books the rest to a **receivable** — the honest
  record of what the platform is owed back, rather than a shortfall quietly papered over.

Up front, maturity and velocity keep stolen value from reaching irreversible cash; after the fact, the
receivable accounts for the gap. Promo credit, which is never purchased, skips the maturity hold.

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

### Event delivery (the outbox)

Some operations emit a **domain event** — a sale completed, a payout settled. Each is written to an
**outbox** table _in the same transaction_ as the money move (so it can't be lost or double-counted),
and the background worker's **relay** job ships pending events out through the configured `Dispatcher`:

- **`DISPATCHER_URL`** — the relay `POST`s each event as JSON here, with an
  `Idempotency-Key: <event id>` header. This is _your_ endpoint — an internal event bus, broker, or
  webhook receiver; `https://bus.internal/economy` is just an illustrative placeholder. The economy
  is the **producer**; the receiver is yours to build, out of scope here like the payout provider.
- **`SQS_QUEUE_URL`** — the same events to an Amazon SQS queue instead (wins if both are set).
- **neither set** — events stay in the outbox, undelivered; nothing leaves the process.

Delivery is **at-least-once** (a send can succeed while marking it done fails, so it resends), so the
receiver dedupes by event id; an event that keeps failing is dead-lettered after `MAX_OUTBOX_ATTEMPTS`.

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
make smoke       # live adapter smoke against real Redis/SQS/HTTP; skips any that aren't running
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
