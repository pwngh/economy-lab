# The Right Way — move the ledger's truth into the engine

> A port is correct for something you don't own. It is wrong for your system of record.

## In one sentence

The database stops being a swappable adapter and becomes the **system of record**:
each engine enforces the ledger invariants natively. Genuine externals stay injected
capabilities. Memory stops being a backend and becomes the test oracle.

## The cut (vocabulary)

- **System of record** — Postgres **or** MySQL. Both kept as first-class options. A native
  schema per engine that _owns_ the invariants. Not an adapter, not behind a generic `Ledger`
  port pretending an in-memory `Map` is its equal.
- **Capability** — Redis cache, SQS/HTTP dispatcher, payout `processor`, FX `rates`, `signer`,
  and the outbox **relay**. These you don't own → they stay injected ports. (The outbox _table_
  is record; the _relay that ships it_ is a capability. Same for `trust_attempts`.)
- **Reference** — the in-memory store. Demoted to a test/dev oracle for happy-path parity only.
  Off the production path.

## Invariants (named; every step cites one)

- **I1 conservation** — a posting's legs sum to 0 per currency.
- **I2 no overdraft** — user balances never < 0 (system accounts exempt).
- **I3 chain continuity** — a link's `prev_hash` = the account's current head; one link per
  (posting, account); no fork.
- **I4 exactly-once** — idempotency key unique; webhook event id unique.
- **I5 balance integrity** — the stored balance equals the sum of an account's legs.
- **I6 serializable concurrency** — no lost update, no velocity TOCTOU.

Out of band — the DB _cannot_ self-enforce these; they stay runtime audits:

- **I7 tamper-evidence** — re-hash chain + verify the signed checkpoint.
- **I8 backing** — USD held ≥ credits owed.

## The law of ordering (do not break it)

> **Add engine enforcement → prove it with an adversarial test that writes the violation
> _around_ the app → only then delete the app-side duplicate.**

Never delete before the test is green. Every phase ships green. The original attempt failed
because it went app-first and never wrote the adversarial test, so it never earned the right
to delete the app copy — and the database stayed a commented "safety net" forever.

## Engine asymmetry (decide once, applies throughout)

- **Postgres** enforces **declaratively**: `DEFERRABLE INITIALLY DEFERRED` constraint triggers,
  `CHECK`, partial/unique indexes, `SERIALIZABLE`.
- **MySQL** has no deferrable constraints and row-only triggers that can't see a whole posting
  mid-statement. So on MySQL the enforcement is: **the stored procedure is the sole write door,
  and the app role gets `EXECUTE` on it and _no_ direct DML** on `legs`/`postings`/`chain_links`/
  `account_balances`. Least privilege is MySQL's substitute for a deferred constraint.

Both are in-engine. Both beat app-side. The conformance suite records _which mechanism_ each
engine uses — it does not pretend they are identical.

## The order

0. **Boundary rename.** `src/adapters/{postgres,mysql}` → `src/engines/*`; cache/queue/processor/
   rates/signer stay ports; move the memory store under `test/`. Mechanical, no behavior change.
   This _is_ the new mental model — the database is not an adapter.

1. **Adversarial harness (keystone — build before any enforcement).** For each engine, attempt
   every violation (I1–I5) by writing **raw rows around the app**, assert rejection. Most fail
   today; the failures are the worklist for steps 2–6. Tag each with the expected mechanism
   (PG: constraint; MySQL: procedure + revoked DML).

2. **I4 — ratify.** Already in-engine: idempotency PK ([schema:127](../db/postgresql-schema.sql)),
   `seen_webhooks` PK. Add the double-claim adversarial test → green on both immediately. This is
   the template. Drop any app pre-check that only duplicates the unique constraint (keep the
   catch for a kind error).

3. **I3 — continuity, structural.** PG: keep `unique (account_id, prev_hash)`
   ([schema:102](../db/postgresql-schema.sql)); add a trigger that `prev_hash` = the account's
   current head. MySQL: same via `BEFORE INSERT` trigger inside the proc's write. Adversarial:
   insert a discontinuous link and a fork → both rejected. Then delete the write path's reliance
   on app-computed continuity (keep `proveChain` for I7 only).

4. **I1 — conservation, in-engine.** PG: deferred constraint trigger on `legs` asserting
   `sum(amount)=0` grouped by (posting, currency) at commit — fires once per `post_entry`
   ([schema:320](../db/postgresql-schema.sql)). MySQL: assert in the procedure + revoke direct
   DML so the proc is the only door; the adversarial test posts an unbalanced entry through the
   proc (rejected) **and** by raw insert (rejected by privilege). Then delete the app
   conservation fold ([economy.ts:587](../src/economy.ts)); keep it as an audit only.

5. **I5 + I2 — balance integrity, then overdraft.** Replace the hand-maintained
   `account_balances` with a trigger-maintained projection of `legs` (or drop it and derive on
   read). Only now is the non-negative `CHECK` ([schema:116](../db/postgresql-schema.sql))
   trustworthy; add the MySQL `CHECK` counterpart. Adversarial: an overdrawing spend → rejected;
   a hand-written negative/drifted balance → rejected or blocked by privilege. Delete the
   `drift`/`consistent` check — drift is now unrepresentable.

6. **I6 — concurrency.** PG: run the write at `SERIALIZABLE`, retry on `40001` at the edge.
   MySQL: `SERIALIZABLE` (or `SELECT … FOR UPDATE` in fixed key order inside the proc), retry on
   `1213`. Delete app-side `lockAccounts` ordering ([economy.ts:462](../src/economy.ts)). Add a
   **concurrent** adversarial test — N parallel same-account spends — asserting I1/I2/I4 hold and
   exactly the right count commits. (This is the interleaving the sequential prover can't reach.)

7. **Split the suite.** Memory is now reference-only. Two suites: **(a) parity** — legal ops →
   identical observable results across memory/PG/MySQL; **(b) rejection** — the adversarial suite,
   now fully green, mechanisms documented per engine.

8. **Shrink.** `prove()` reduces to **I7 + I8** — the only two the DB can't self-enforce
   ([economy.ts:538](../src/economy.ts)). Flip the README/schema line: _the database enforces the
   invariant; the application declines writes it knows the database will reject, only to return a
   kinder error._

9. **Tooling.** Delete `scripts/migrate.ts`; apply schema with `psql -f` / `mysql <` driven by a
   Makefile. The `GRANT EXECUTE` / `REVOKE` privilege model lives **in** each engine's schema file
   — it is enforcement, not ops.

## The deletion ledger (gone at the end)

app conservation fold · drift/consistent check · app chain-continuity guard · app `lockAccounts`
ordering · memory-as-backend · `migrate.ts` · the "byte-equivalence" definition of portability.

`prove()` = I7 + I8. Everything else moved to where the data lives.
