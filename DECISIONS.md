# Balance holds decisions

- **Keep the API in process.** Holds sit beside the existing payout API. The host can use them without adding a server or changing the HTTP contract.
- **Hold available seller earnings.** A hold moves matured CREDIT from `earned` to its own reserved account. Wallet spending and session escrow keep their existing roles.
- **Store the rules with the money movement.** The opening ledger entry records the owner, amount, event, and expiry. Later entries determine the remainder; there is no separate status flag to reconcile.
- **Count accepted payouts separately.** The balance total is unheld earnings plus holds. Once a payout is accepted, it leaves this total for the existing payout process, so its reserve is not counted twice.
- **Preserve earnings that are still pending.** Holds and payouts use matured earnings when replaying history. Spending newer funds that cleared quickly must not make an older, slower batch look available.
- **Release funds without another wait.** Only funds that already matured can enter a hold. A dedicated release entry returns them as available; a caller-supplied funding label cannot bypass maturity.
- **Keep the existing wait on payout returns.** Returned payout credits wait again, normally using `default`; a configured `unknown` period takes precedence. This preserves the existing payout policy; hold releases remain immediately available.
- **Let the caller supply time.** `now` and `expiresAt` are epoch milliseconds. The host schedules `expire()`, and a hold is due at its exact deadline; the library starts no timer.
- **Make retries safe.** A user and hold ID identify an opening; a user and release key identify a release. Matching retries return the original transaction, while changed business inputs are refused. A new hold needs a new ID.
- **Expire holds one at a time.** Each release has its own transaction. An interrupted expiry call can be retried to finish the remaining holds without requiring a transaction across the whole sweep.
- **Keep debt as an additional check.** The balance buckets come from ledger entries. Pending accrual debt can still block a hold or payout; it is not subtracted from the displayed total before it is posted.
- **Require the full ledger history.** The host must retain complete active history. The API rejects recorded archival where the store reports it, and missing opening evidence. HTTP has no archive-state check; safe archival needs a separate design.
- **Start with history scans.** Reading entries and account names keeps the implementation easy to inspect. Schema version 19 adds the reserved account kind; this pass adds no tables or index-repair process.
- **Leave host decisions with the host.** The application authorizes callers, verifies events, supplies time and policy, and refreshes any separate wallet cache. This feature uses no AI at runtime.
- **Test with disposable databases.** The strict demo creates PostgreSQL, MySQL, and a test runner on a private Docker network. It publishes no ports, uses no existing databases, and fails if a required store cannot run.
