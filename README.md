# Economy Lab

Economy Lab is a TypeScript double-entry ledger for credits, seller earnings, and payouts. Its balance-holds library separates pending earnings, available funds, and reserved holds using ledger entries. The local proof uses invented data and runs the same scenarios on memory, PostgreSQL, MySQL, and the HTTP store adapter.

## Run the balance proof

Install Node 22.18 or newer and Docker with a running daemon, then run from a clean checkout:

```sh
npm run demo:balances
```

The command installs locked dependencies, builds the workspace packages, creates two temporary databases on a private Docker network, runs the shared tests in Node with the checkout mounted read-only, and removes its containers, volumes, and network. No database ports are published. It needs network access for npm packages and uncached images; it needs no account, API key, or paid service. It does not read `.env` or use existing databases.

The demo script is [scripts/demo-balances.mjs](scripts/demo-balances.mjs). Its executable scenarios are [test/conformance/balance-holds.test.ts](test/conformance/balance-holds.test.ts):

1. Credit 1,000 invented minor units. Before the maturity boundary all 1,000 are pending; at the boundary they become available.
2. Reserve 700 in a hold. A payout of 301 fails; a payout of 300 succeeds. The remaining total is 700 reserved.
3. Release part of a hold on a matching event, retry the same request, and expire only the remainder. Advance an explicit timestamp; the hold tests never sleep.
4. Race two full-balance payouts. Exactly one commits. On each SQL store a barrier puts both transactions inside the database before either acquires the account lock.
5. Run seeded programs of holds, partial releases, expirations, payouts, and retries. Compare every step with an independent model and balances recomputed from entries.

## Use the library

Use the same `store`, `config`, and `digest` supplied to your Economy instance:

```ts
import { createBalanceHolds, toAmount } from '@pwngh/economy-lab';

const holds = createBalanceHolds({ store, config, digest });
await holds.place({
  userId: 'usr_example',
  holdId: 'delivery_1',
  amount: toAmount('CREDIT', 700n),
  releaseEvent: 'delivery_confirmed',
  expiresAt: 1_000,
  now: 100,
});
await holds.release({
  userId: 'usr_example',
  holdId: 'delivery_1',
  idempotencyKey: 'delivery_part_1',
  amount: toAmount('CREDIT', 200n),
  event: 'delivery_confirmed',
  now: 200,
});
await holds.expire({ userId: 'usr_example', now: 1_000 });
const balance = await holds.read({ userId: 'usr_example', now: 1_000 });
```

The account must already have enough available earnings. Continue to request payouts with `economy.submit(requestPayout(...))`; its existing transaction locks and idempotency protect the payout. Existing debt and payout-policy checks can additionally refuse a request. `pending + available + reserved = total` describes earnings still managed by this API. An accepted payout leaves that total and enters the existing payout saga; `reserved` here counts balance holds only.

This is a trusted in-process API: the host authorizes callers, verifies events, supplies time, and invokes expiry from its scheduler. A timer becoming due does not itself post an entry. `place` and `release` return a committed or duplicate receipt; malformed input, a conflicting retry, or unavailable funds throw a typed `EconomyError`.

## Tests and measurements

`npm run demo:balances` is the complete, strict feature test command. Missing database coverage fails it. After dependencies and packages are built, `npm run test:balances` runs against configured stores; unavailable SQL stores are explicitly skipped unless `BALANCE_HOLDS_REQUIRE_STORES=1`.

The observed feature run passed 44 tests with zero skips across four adapters. Each adapter ran 32 seeded programs and 624 generated steps: 128 programs and 2,496 steps in total. There were 48 payout races, including 24 pairs proven to overlap inside PostgreSQL/MySQL transactions; exactly one payout committed in each pair. The clean-checkout test phase took about 54 seconds in the local Docker run, excluding dependency installation and builds. These are correctness measurements, not a throughput benchmark or proof over all possible programs.

The wider repository gate is `npm run check`; it additionally needs generated API documentation, application dependencies, and other local services. See [test/README.md](test/README.md) for the repository test conventions.

## Existing ledger workflows

The rest of Economy Lab remains available: wallets, marketplace sales, refunds, subscriptions, payout processing, and integrity checks. The existing worker runs 16 sweeps; it and the local service use the module at [economy/app.ts](economy/app.ts).

```sh
npm run dev          # existing local development service
npm test             # root test suite; unavailable backends report skips
npm run prove        # randomized ledger invariant checks
npm run fuzz         # compare storage implementations
```

The [Economy API](https://economy-lab-docs.pages.dev/economy/reference/the-economy/), [ledger accounts](https://economy-lab-docs.pages.dev/economy/concepts/accounts-and-double-entry/), [worker](https://economy-lab-docs.pages.dev/economy/reference/background-worker/), and [package guide](https://economy-lab-docs.pages.dev/economy/ports/packages/) cover those workflows. The existing [documentation app](apps/docs) and [console](apps/console) retain their own sources and setup; this feature adds no endpoints or screens.

## Limits

- Holds reserve matured CREDIT earnings only. Currency conversion, fees, an API server, and a UI were not added for this feature.
- Full hot ledger history is required. The holds API refuses recorded archival or missing opening evidence; archive-aware releases are not implemented.
- SQL schema version 19 adds the reserved account kind. The demo uses fresh databases; upgrading an existing persistent database is not automated by this feature.
- Earned maturity reads replay account history, and hold discovery scans account names. This favors inspectable correctness over large-account throughput.
- This API reads the store directly. Hosts using other cached wallet reads must invalidate them or allow their configured expiry after a hold change.
- Event delivery, authorization, clock accuracy, and scheduling belong to the host. Tests use fakes and local databases; no external payout rail is exercised.
- Administrative ledger edits, historical payout allocation before this version, and arbitrary changes to maturity policy are outside the generated model.

With two more days, I would add an indexed hold-discovery projection checked against the ledger and measure read cost as history grows, then design retention that preserves active hold evidence.

The one-page [invariants and enforcement note](BALANCE_HOLDS.md) and [decisions](DECISIONS.md) describe the implementation boundaries. The existing [documentation](https://economy-lab-docs.pages.dev/economy/) covers the ledger, stores, payout saga, subscriptions, and other packages. License: [MIT](LICENSE.md).
