-- @pwngh/economy-lab
--
-- Copyright (c) Preston Neal
--
-- This source code is licensed under the MIT license found in the
-- LICENSE.md file in the root directory of this source tree.
--
-- @license MIT

-- PostgreSQL schema for the whole system, every table in one declarative file.
--
-- The ledger is append-only: never edit a balance, only add postings (debit/credit "legs").
-- An account's balance is the sum of its legs. `account_balances` caches that sum for fast
-- reads; the prover re-adds the legs and the legs win on disagreement.
--
-- Every CHECK here is also a rule in the TypeScript code, so the DB enforces each invariant
-- twice. Money is whole minor units (cents for USD, 1 for a credit) in BIGINT columns;
-- drivers return these as JS BigInt, never float.
--
-- Apply once, by hand or in CI. Declares the current shape outright: no migrations, no
-- `if not exists`, no backfills. Never run on app startup.

-- ============================================================================
-- Accounts money can be posted to. Platform "system" accounts are seeded below; user
-- accounts are created on first posting. `currency` fixes whether an account holds CREDIT
-- or USD, so a posting can check all its legs use one currency.
-- ============================================================================
create table accounts (
  id         text        primary key,
  kind       text        not null check (kind in ('spendable', 'earned', 'promo', 'system')),
  currency   text        not null check (currency in ('CREDIT', 'USD')),
  created_at timestamptz not null default now()
);

-- Platform accounts, inserted once. User accounts (`usr_<uuid>:<kind>`) are created on
-- first posting, so they need no seed row.
insert into accounts (id, kind, currency) values
  ('platform:trust_cash',     'system', 'USD'),
  ('platform:revenue',        'system', 'CREDIT'),
  ('platform:stored_value',   'system', 'CREDIT'),
  ('platform:payout_reserve', 'system', 'CREDIT'),
  ('platform:receivable',     'system', 'CREDIT'),
  ('platform:promo_float',    'system', 'CREDIT'),
  ('platform:usd_clearing',   'system', 'USD'),
  ('platform:revenue_usd',    'system', 'USD'),
  ('platform:opening_equity', 'system', 'CREDIT');

-- ============================================================================
-- Postings: the append-only record of everything that happened. Each posting splits into
-- debit/credit lines ("legs") in `legs`, plus one hash-chain link per touched account in
-- `chain_links`. Leg amounts are signed (debit positive, credit negative) so legs sum to
-- zero per currency when balanced, which the conservation check verifies.
-- ============================================================================
create table postings (
  id         text        primary key,                      -- transaction id, like txn_<uuid>
  meta       jsonb       not null default '{}',
  posted_at  bigint      not null,                          -- commit time, in epoch milliseconds
  seq        bigserial   unique,                            -- ever-increasing number giving postings a total order
  created_at timestamptz not null default now()
);

-- One leg = one debit or credit line of a posting. Amount is signed (debit positive, credit
-- negative) and never zero (a zero leg is a no-op posting, i.e. a bug). A posting can have
-- several legs to the same account (e.g. a promo-funded spend credits a seller twice, once
-- from revenue and once from the fee split), so the hash-chain link lives in `chain_links`
-- (one per account), not on each leg.
create table legs (
  id         bigserial   primary key,
  posting_id text        not null references postings (id),
  account_id text        not null references accounts (id),
  currency   text        not null check (currency in ('CREDIT', 'USD')),
  amount     bigint      not null check (amount <> 0)
);
create index legs_account_idx on legs (account_id);
create index legs_posting_idx on legs (posting_id);

-- One hash-chain link per (posting, account): each posting advances an account's chain once,
-- regardless of how many legs touch that account. Records the previous and new hash. The hash
-- (64 lowercase hex) is computed in application code, never in SQL, from the previous hash, the
-- transaction id, that account's legs, and the posting metadata. Keeping the link separate from
-- the legs lets a posting hold several same-account legs while the recomputed hash still covers
-- the same leg set the in-memory reference implementation uses.
create table chain_links (
  posting_id text        not null references postings (id),
  account_id text        not null references accounts (id),
  prev_hash  text        not null,                          -- previous hash, 64 lowercase hex; the first link uses 32 zero bytes
  hash       text        not null,                          -- the new hash, 64 lowercase hex
  -- The composite PK enforces the one-link-per-(posting,account) invariant stated above.
  primary key (posting_id, account_id)
);
create index chain_links_account_idx on chain_links (account_id);
-- A previous-hash can be used only once per account, so two postings can't both attach at
-- the same point and fork the chain into two branches.
create unique index chain_links_account_prev_uq on chain_links (account_id, prev_hash);

-- ============================================================================
-- Cached per-account balances: the fast read model, updated in the same transaction as the
-- legs that change it. Always re-derivable from the legs, never the source of truth. The
-- non-negative CHECK below is the DB's half of the overdraft guard: a user account may never
-- drop below zero. System accounts are exempt; several hold negative balances by design.
-- ============================================================================
create table account_balances (
  account_id text   not null primary key references accounts (id),
  currency   text   not null check (currency in ('CREDIT', 'USD')),
  balance    bigint not null default 0,
  -- A user account (`usr_…:<kind>`) may never go negative; a system account may.
  constraint user_account_non_negative
    check (account_id like 'platform:%' or balance >= 0)
);

-- ============================================================================
-- Idempotency: makes a retried request safe to run twice. The key is the primary key, so the
-- DB prevents duplicates. A request claims its key when it starts; a second request with the
-- same key waits for the first, then replays its recorded result. A rolled-back first request
-- leaves no row, so a fresh retry proceeds.
-- ============================================================================
create table idempotency (
  key         text        primary key,
  transaction jsonb       not null,                         -- the recorded result, replayed verbatim on a duplicate; NOT NULL because PG claims via an advisory lock (pg_advisory_xact_lock), so the row is only ever written with a result, never a placeholder
  created_at  timestamptz not null default now()
);

-- ============================================================================
-- Webhook replay dedup: exactly-once guard for inbound provider callbacks, kept separate from
-- the domain's `idempotency` table so the two layers can't collide on a shared key. A verified
-- webhook claims its provider event id here as the last gate (after HMAC and freshness checks),
-- so a forged or stale delivery that fails an earlier check never burns the id, leaving a later
-- genuine delivery free to credit. The event id is the primary key: a second delivery of the
-- same id finds the row present and does no work.
-- ============================================================================
create table seen_webhooks (
  event_id text        primary key,                        -- the provider's stable event id
  seen_at  timestamptz not null default now()
);

-- ============================================================================
-- Sales: a summary of each purchase, keyed by its order id (separate from the idempotency
-- key) so a refund can reverse exactly what was posted. `price` and `fee` are minor units;
-- `legs` stores the posted lines as decimal-string amounts so they round-trip exactly.
-- ============================================================================
create table sales (
  order_id     text        primary key,
  buyer_id     text        not null,
  recipient_id text,
  sku          text        not null,
  price        bigint      not null check (price > 0),
  fee          bigint      not null check (fee >= 0),
  legs         jsonb       not null,
  txn_id       text        not null references postings (id),
  posted_at    bigint      not null
);

-- ============================================================================
-- Outbox: events waiting to be published, written in the same transaction as the ledger change
-- that caused them, so an event and its ledger effect always exist together. A background relay
-- grabs a batch (locking those rows so workers don't collide), publishes them, and marks them
-- relayed; a consumer may see an event more than once, so it dedupes on the event id. The
-- partial index keeps the pending-rows scan fast.
-- ============================================================================
create table outbox (
  id                 text        primary key,                -- obx_<uuid>
  event              jsonb       not null,                   -- the event payload to publish
  status             text        not null default 'pending'
                       check (status in ('pending', 'relayed', 'failed')),
  attempts           int         not null default 0,
  -- If the relay gives up after repeated failures it marks the row 'failed' and stores the
  -- last error code here; null while the row is still pending or already relayed.
  dead_letter_reason text,
  created_at         timestamptz not null default now()
);
create index outbox_pending_idx on outbox (created_at) where status = 'pending';

-- ============================================================================
-- Payouts: a multi-step saga that moves a creator's earned credits out to real money. Only the
-- background worker advances it, never a normal request. `reserve` is the earned credit set
-- aside for this payout; `rate_id` pins the credit-to-USD rate so the settlement can be
-- reproduced and disputed later.
-- ============================================================================
create table payout_sagas (
  id                 text   primary key,                    -- pay_<uuid>
  user_id            text   not null,
  reserve            bigint not null check (reserve > 0),
  rate_id            text   not null,
  state              text   not null
                       check (state in ('REQUESTED', 'RESERVED', 'SUBMITTED', 'SETTLED', 'FAILED')),
  provider_ref       text,
  attempts           int    not null default 0,
  -- Why the worker gave up on this payout (when state is 'FAILED'); null otherwise. Stored
  -- here too so it matches the in-memory and MySQL adapters.
  dead_letter_reason text,
  due_at             bigint not null,
  updated_at         bigint not null
);
-- The worker's due-payouts scan only looks at RESERVED and SUBMITTED rows. A payout becomes
-- RESERVED in the request that opens it, so a row still in REQUESTED at scan time means that
-- request crashed partway; the worker skips it rather than picking up a half-finished payout
-- forever. The CHECK above allows all five states; this index (and the matching query) narrow
-- it to the two scannable ones.
create index payout_sagas_due_idx on payout_sagas (due_at)
  where state in ('RESERVED', 'SUBMITTED');

-- ============================================================================
-- Promo grants: one row per promotional credit handed out. Shares the id of the posting that
-- granted it, so re-running the grant is harmless. A background sweep finds expired, not-yet-
-- reversed grants oldest first, reverses whatever the user didn't spend, then sets `reversed`
-- so each grant reverses at most once. `amount` is the full original grant in minor units.
-- ============================================================================
create table promo_grants (
  id         text   primary key,                          -- txn_<uuid>, shared with the posting
  user_id    text   not null,
  amount     bigint not null check (amount >= 0),
  currency   text   not null check (currency in ('CREDIT', 'USD')),  -- always CREDIT in practice; kept for parity with other tables
  expires_at bigint not null,
  reversed   boolean not null default false
);
-- Index over only the not-yet-reversed rows, in expiry order, so the sweep's scan stays small.
create index promo_grants_due_idx on promo_grants (expires_at) where reversed = false;


-- ============================================================================
-- Entitlements: what a user owns (access to a SKU), tracked separately from the money ledger.
-- At most one row per (user, SKU). A null `expires_at` means it never lapses; `revoked` is set
-- when a refund or clawback takes the entitlement away.
-- ============================================================================
create table entitlements (
  user_id    text        not null,
  sku        text        not null,
  quantity   int         not null default 1 check (quantity >= 0),
  version    int         not null default 1,
  expires_at bigint,
  revoked    boolean     not null default false,
  source     text,
  granted_at timestamptz not null default now(),
  primary key (user_id, sku)
);

-- ============================================================================
-- Subscriptions: recurring charges. Each billing period uses its own idempotency key, so the
-- renewal sweep can safely retry. Holds the subscription's current state; `next_due_at` is what
-- the due-to-bill scan reads.
-- ============================================================================
create table subscriptions (
  id           text   primary key,                          -- sub_<uuid>
  user_id      text   not null,
  seller_id    text   not null,
  sku          text   not null,
  price        bigint not null check (price > 0),
  period_ms    bigint not null check (period_ms > 0),
  state        text   not null check (state in ('ACTIVE', 'LAPSED', 'CANCELED')),
  period       int    not null default 1,
  -- How many times billing this subscription has failed in a row; reset to 0 after a
  -- successful charge. Once it reaches the configured limit, the renewal sweep marks it LAPSED.
  attempts     int    not null default 0,
  next_due_at  bigint not null,
  updated_at   bigint not null
);
create index subscriptions_due_idx on subscriptions (next_due_at) where state = 'ACTIVE';

-- ============================================================================
-- Velocity / risk log: one row per attempt, used to sum how much a subject has tried to spend
-- over a recent window. Written outside the normal transaction rollback on purpose, so a
-- rejected attempt still counts and a burst of declines (a likely fraud signal) isn't free.
-- Keyed on the idempotency key so a genuine retry isn't counted twice.
-- ============================================================================
create table trust_attempts (
  idempotency_key text   primary key,
  subject         text   not null,
  amount          bigint not null,
  outcome         text   not null check (outcome in ('committed', 'rejected')),
  at              bigint not null
);
create index trust_attempts_subject_at_idx on trust_attempts (subject, at);

-- ============================================================================
-- Checkpoints: a signed snapshot of the ledger's state. Each row holds a Merkle root (one hash
-- summarizing every account's latest hash) plus a signature made with a key the ledger writer
-- can't reach. An insider who rewrites an account history and recomputes its hashes is caught:
-- the new root no longer matches the old signature. `root` and `signature` are lowercase hex.
-- In production this table lives in a separate, tamper-proof store.
-- ============================================================================
create table checkpoints (
  id         text        primary key,                       -- chk_<uuid>
  root       text        not null,                          -- lowercase hex Merkle root
  signature  text        not null,                          -- lowercase hex
  count      bigint      not null,                          -- how many account hashes this root covers
  at         bigint      not null,
  seq        bigserial   unique,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- Stored routines (persistence) + the engine's invariant enforcement. The application computes the
-- values a posting needs (which way each account moves, the per-account net delta, the chain hashes,
-- the account kind) and passes them in finished; these routines write the rows in one `call` rather
-- than a dozen-plus round-trips, as one set-based unit inside the caller's transaction. But the
-- ledger invariants are no longer the application's to guarantee — the database is the primary
-- enforcer, not a safety net: the CHECK constraints above plus the triggers at the end of this file
-- reject a write that violates conservation, no-overdraft, chain continuity, exactly-once, or balance
-- integrity, even when it bypasses the application entirely. The app keeps the same checks only as
-- friendly pre-checks that return a kind error.
-- ============================================================================

-- Persist one posting and everything derived from it in a single call: ensure any first-time
-- user accounts (system accounts are seeded above), insert the posting row, all its legs, one
-- chain link per account, and apply each account's net balance delta. bigint amounts arrive as
-- JSON strings (no precision lost past 2^53) and are cast here. The balance step UPDATEs existing
-- rows first, so the non-negative CHECK is evaluated against the new total, not the delta alone,
-- then INSERTs first-time accounts, whose first movement is always a positive credit.
create procedure post_entry(
  p_txn          text,
  p_posted_at    bigint,
  p_meta         jsonb,
  p_legs         jsonb,   -- [{account, currency, amount}]   raw signed: debit +, credit −
  p_links        jsonb,   -- [{account, prev_hash, hash}]    one per distinct account
  p_balances     jsonb,   -- [{account, currency, delta}]    per-account net balanceDelta
  p_new_accounts jsonb    -- [{id, kind, currency}]          user accounts created on first use
)
language plpgsql
as $$
begin
  insert into accounts (id, kind, currency)
    select a.id, a.kind, a.currency
      from jsonb_to_recordset(p_new_accounts) as a(id text, kind text, currency text)
    on conflict (id) do nothing;

  insert into postings (id, meta, posted_at) values (p_txn, p_meta, p_posted_at);

  insert into legs (posting_id, account_id, currency, amount)
    select p_txn, l.account, l.currency, l.amount::bigint
      from jsonb_to_recordset(p_legs) as l(account text, currency text, amount text);

  insert into chain_links (posting_id, account_id, prev_hash, hash)
    select p_txn, c.account, c.prev_hash, c.hash
      from jsonb_to_recordset(p_links) as c(account text, prev_hash text, hash text);

  update account_balances ab
     set balance = ab.balance + d.delta::bigint
    from jsonb_to_recordset(p_balances) as d(account text, currency text, delta text)
   where ab.account_id = d.account;

  insert into account_balances (account_id, currency, balance)
    select d.account, d.currency, d.delta::bigint
      from jsonb_to_recordset(p_balances) as d(account text, currency text, delta text)
     where not exists (
       select 1 from account_balances ab where ab.account_id = d.account
     )
    on conflict (account_id)
      do update set balance = account_balances.balance + excluded.balance;
end;
$$;

-- Return one account's cached balance (0 when it has no row yet). The fast read model the
-- statement and prove paths build on; wrapping it as a function gives one named access path.
create function account_balance(p_account text)
returns bigint
language sql
stable
as $$
  select coalesce(
    (select balance from account_balances where account_id = p_account),
    0
  );
$$;

-- ============================================================================
-- chain continuity. The unique index above already blocks a FORK (a second
-- link at the same prev_hash). This blocks a DISCONTINUOUS link: a new link's prev_hash must be the
-- account's current head — GENESIS (64 zeros) for the first link, or an existing link's hash for the
-- account thereafter. The legitimate writer (advanceHeads, src/chain.ts) always supplies the current
-- head, so this only rejects a link written around post_entry.
-- ============================================================================
create or replace function chain_continuity() returns trigger as $$
begin
  if new.prev_hash = repeat('0', 64) then
    if exists (select 1 from chain_links where account_id = new.account_id) then
      raise exception 'chain continuity: genesis link for account % on a non-empty chain', new.account_id;
    end if;
  elsif not exists (
    select 1 from chain_links where account_id = new.account_id and hash = new.prev_hash
  ) then
    raise exception 'chain continuity: prev_hash % is not the current head of account %',
      new.prev_hash, new.account_id;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace trigger chain_links_continuity
  before insert on chain_links
  for each row execute function chain_continuity();

-- ============================================================================
-- conservation (Postgres). A posting's legs must net to zero per currency. A
-- DEFERRABLE INITIALLY DEFERRED constraint trigger checks at COMMIT, so post_entry can insert all of
-- a posting's (balanced) legs before the check runs, while a lone unbalanced leg written around the
-- app fails at its commit. This is the engine half of assertBalanced (src/ledger.ts), which the app
-- keeps as the friendly pre-check.
-- ============================================================================
create or replace function check_conservation() returns trigger as $$
begin
  if (select coalesce(sum(amount), 0)
        from legs
       where posting_id = new.posting_id and currency = new.currency) <> 0 then
    raise exception 'conservation: posting % legs in % do not net to zero',
      new.posting_id, new.currency;
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists legs_conserve on legs;
create constraint trigger legs_conserve
  after insert on legs
  deferrable initially deferred
  for each row execute function check_conservation();

-- ============================================================================
-- balance integrity (Postgres). account_balances is a cache of the legs: its
-- value must equal the legs' net for the account, signed by the account's normal side — debit-normal
-- accounts grow on debits (+SUM), credit-normal grow on credits (-SUM). post_entry writes exactly
-- that, so this only rejects a hand-edited balance that has drifted from the legs. The debit-normal
-- set mirrors isDebitNormal (src/accounts.ts).
-- ============================================================================
create or replace function check_balance_integrity() returns trigger as $$
declare
  expected bigint;
begin
  expected := (case when new.account_id in (
      'platform:trust_cash','platform:usd_clearing','platform:revenue_usd',
      'platform:stored_value','platform:receivable','platform:promo_float','platform:opening_equity'
    ) then 1 else -1 end)
    * coalesce((select sum(amount) from legs where account_id = new.account_id), 0);
  if new.balance <> expected then
    raise exception 'balance integrity: account % cached balance % <> signed leg sum %',
      new.account_id, new.balance, expected;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace trigger account_balances_integrity
  before insert or update on account_balances
  for each row execute function check_balance_integrity();
