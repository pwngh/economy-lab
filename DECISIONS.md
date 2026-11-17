# Balance holds decisions

- **Extend the ledger locally.** Add an in-process library beside the existing payout API. This avoids widening the HTTP contract or introducing a new service.
- **Reserve matured seller earnings.** A hold debits `earned` and credits an excluded per-hold reserved account. Spendable wallets and session escrow keep their existing meanings.
- **Keep conditions in entries.** The opening posting records the owner, amount, event, and expiry. The remaining hold is its ledger balance, with no mutable status flag or new storage table.
- **Define the total narrowly.** Total is unheld earnings plus balance holds. An accepted payout leaves this total for the existing saga; its pooled reserve is not counted again.
- **Preserve pending funds.** New payouts and holds consume mature earned lots. Replaying earned history prevents a debit from making an older immature lot appear payable when sources have different waits.
- **Do not restart maturity on release.** A dedicated release posting returns previously matured funds with their release time. A free-form funding source cannot mark itself as a hold release.
- **Pass time explicitly.** Host-supplied epoch milliseconds determine eligibility. `expire` is an explicit scheduler tick with an inclusive deadline; the library creates no timer.
- **Use stable receipts.** A hold identity and release key produce deterministic transaction IDs. A retry with the same meaning replays; different content under the same identity is refused. Payouts keep the established idempotency pipeline.
- **Keep debt as a separate policy gate.** Balance buckets derive from ledger entries. Existing accrual debt can additionally block a hold or payout, just as payout minimums or payee checks can; unposted accruals are outside the total.
- **Require full hot history.** Missing opening evidence or recorded archival fails closed. Retaining active anchors through archival needs a separate design.
- **Prefer a small implementation over projections.** Read paths scan ledger history and account names. SQL schema version 19 admits the reserved account kind; no new tables or projection repair process are required.
- **Keep the host boundary explicit.** The host verifies events, authorizes callers, supplies a consistent clock and policy, and invalidates any separate wallet cache. This feature adds no AI runtime step.
- **Prove actual databases.** The strict demo creates its own PostgreSQL, MySQL, and test-runner containers on a private network, with no published ports. It does not accept missing SQL coverage or touch a developer's existing databases.
