# Economy Lab

Economy Lab is a TypeScript double-entry ledger for credits, seller earnings, and payouts. It tracks which earnings are still waiting, which are available for payout, and which are set aside in a hold. Its balance-holds demo uses invented data to check the same rules on memory, PostgreSQL, MySQL, and the HTTP store adapter.

## How the balances work

| Balance   | Meaning                                                          |
| --------- | ---------------------------------------------------------------- |
| Pending   | Earnings that have not finished their configured waiting period. |
| Available | Earnings that have finished that wait and are not held.          |
| Reserved  | Earnings set aside in balance holds.                             |
| Total     | The sum of pending, available, and reserved earnings.            |

A hold moves available earnings into reserved. A release moves them back without starting another waiting period. Both movements are ledger entries, so the balances can be rebuilt from the record of what happened. The rule is `pending + available + reserved = total`.

For example, a seller earns 1,000 minor units. Once they become available, a hold of 700 leaves 300 available for payout. A request for 301 is refused; a request for 300 succeeds. The remaining total is then 700, all reserved.

An accepted payout leaves this total and enters Economy Lab's existing payout process. Its separate payout reserve is not included in the `reserved` balance above. Debt, payout minimums, and other payout rules can still block a request even when enough earnings are available.

If a payout is reversed or the worker gives up on it, the returned credits go back to `earned` and wait again. The usual configuration uses the `default` period. A host that supplies a separate `unknown` period uses that instead, because the return has no funding-source tag. A hold release returns funds as available immediately.

## Run the demo and tests

You need Node 22.18 or newer, Docker, and a running Docker daemon. From a clean checkout, run:

```sh
npm run demo:balances
```

The command installs the locked dependencies, builds the packages, starts temporary PostgreSQL and MySQL databases, and runs the tests across all four adapters. It then removes the containers, database volumes, and private Docker network it created. A successful run exits with code 0 and prints:

```text
balance proof: passed with memory, PostgreSQL, MySQL, and HTTP
```

The runner mounts the checkout read-only inside its test container. It publishes no database ports, does not read `.env`, and does not use your existing databases. Network access is needed to download npm packages and any Docker images that are not already cached; no account, API key, or paid service is needed.

The [demo script](scripts/demo-balances.mjs) runs these [executable scenarios](test/conformance/balance-holds.test.ts), each with separate test data:

1. Add 1,000 units of earnings and advance the supplied time. They are pending before the waiting period ends and available at its boundary.
2. Hold 700 units, reject a payout of 301, and accept a payout of 300.
3. Release 200 from a 700-unit hold after a matching event. Repeat the request without moving money again, then expire the remaining 500 at the deadline.
4. Request two payouts that each need the full available balance. Exactly one succeeds. On each SQL store, a barrier makes both database transactions start before either can take the account lock.
5. Run repeatable sequences of holds, partial releases, expirations, payouts, and retries. After every step, compare the balances with an independent model and with the ledger entries.

## Use the library

Create the holds API with the same `store`, `config`, and `digest` as your Economy instance. The account must already have enough available earnings; this example assumes at least 700. The timestamps are invented epoch milliseconds, passed explicitly so the example needs no real timer.

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

A hold needs an expiry time, a release event, or both. Either a matching event or a reached deadline allows a release. Supply `amount` for a partial release; omit it to release the remainder. `read()` reports balances without changing them. Your scheduler must call `expire()` to release due holds; the deadline alone moves no money.

Use a new `holdId` for each new hold, even after an earlier hold is fully released. Retry the same opening with the same hold ID. Retry a release with the same `idempotencyKey`: that key identifies one release request for the user across all their holds. A later `now` is allowed on a retry; reusing an identity with different business inputs is refused.

User and hold IDs preserve case: `Review` and `review` identify different holds. The shared tests check that case-distinct owners also keep separate balances.

Successful `place` and `release` calls return a receipt with `committed` or `duplicate` status. Invalid input, conflicting retries, insufficient funds, or broken history throw a typed `EconomyError`.

Continue to request payouts through `economy.submit(requestPayout(...))`. Holds and payouts use the same account lock, and payout requests retain their existing idempotency checks. Your application must authorize callers, verify events, supply a consistent clock and policy, and schedule expiry. Each hold expires in its own transaction, so an interrupted sweep can be retried to finish the remaining holds.

## What the tests show

`npm run demo:balances` is the complete feature check: it fails if database coverage is missing. Once dependencies and packages are built, `npm run test:balances` uses configured stores instead. That shorter command reports unavailable SQL stores as skips unless `BALANCE_HOLDS_REQUIRE_STORES=1`.

A recorded feature run passed 52 tests with no skips across four adapters. Each adapter ran 32 generated programs and checked 624 steps: 128 programs and 2,496 steps overall. All 48 payout races had exactly one winner, including 24 pairs that overlapped inside PostgreSQL or MySQL transactions. In one local Docker run, the test phase took about 29 seconds, excluding installation and builds.

These checks exercise a reproducible sample of operation sequences. They are evidence of correctness for those cases, not a throughput benchmark or a proof of every possible sequence.

The broader repository check is `npm run check`. It also needs generated API documentation, app dependencies, and other local services. [The test guide](test/README.md) describes that setup and the repository's test conventions.

## Other ledger workflows

Economy Lab also supports wallets, marketplace sales, refunds, subscriptions, payout processing, and integrity checks. The existing worker runs 16 sweeps; it and the local service use [economy/app.ts](economy/app.ts).

```sh
npm run dev          # start the existing local development service
npm test             # root tests; unavailable backends report skips
npm run prove        # randomized ledger invariant checks
npm run fuzz         # compare storage implementations
```

The [Economy API](https://economy-lab-docs.pages.dev/economy/reference/the-economy/), [ledger accounts](https://economy-lab-docs.pages.dev/economy/concepts/accounts-and-double-entry/), [worker](https://economy-lab-docs.pages.dev/economy/reference/background-worker/), and [package guide](https://economy-lab-docs.pages.dev/economy/ports/packages/) describe those workflows. The [documentation app](apps/docs) and [console](apps/console) have their own setup instructions. Balance holds add an in-process API; they add no endpoints or screens.

## Limits and next steps

- Holds apply to matured CREDIT earnings. This feature adds no currency conversion, fees, API server, or UI.
- The host must keep complete hold history in active storage. The API rejects recorded archival when the store exposes archive state; the HTTP adapter cannot report that state. Missing opening entries cause an error. Releasing holds from archived history is not supported.
- SQL schema version 20 makes MySQL identifiers case-sensitive; older schema versions are refused at startup. The demo creates fresh databases. Existing databases need a planned migration; the supplied schema scripts rebuild tables and must not be used to preserve existing data.
- Balance reads scan earnings history, and finding holds scans account names. Read cost grows with that data; an indexed projection is not implemented.
- The holds API reads the store directly. If your application caches wallet reads elsewhere, it must invalidate those caches after a hold change or wait for their configured expiry.
- The host owns event delivery, authorization, clock accuracy, and scheduling. Tests use local databases and fakes; they do not execute a payment through an external provider.
- The generated model does not cover administrative ledger edits, payout allocation before this version, or arbitrary changes to the waiting-period rules.

With two more days, I would index hold discovery, check that index against the ledger, and measure read cost as history grows. Next I would design archival that keeps enough evidence to release active holds safely.

The one-page [invariants and enforcement note](BALANCE_HOLDS.md) explains the rules and their tests. [DECISIONS.md](DECISIONS.md) records the tradeoffs. The full [documentation](https://economy-lab-docs.pages.dev/economy/) covers the rest of the ledger. License: [MIT](LICENSE.md).
