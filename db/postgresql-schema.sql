-- @pwngh/economy-lab
--
-- Copyright (c) Preston Neal
--
-- This source code is licensed under the MIT license found in the
-- LICENSE.md file in the root directory of this source tree.
--
-- @license MIT

-- The PostgreSQL schema for the whole system — every table in one declarative file.
--
-- The ledger is append-only: you never edit a balance directly, you only add postings
-- (each made of debit and credit "legs"). An account's true balance is the sum of its
-- legs. The `account_balances` table stores that sum so reads are fast, but it is only a
-- cached copy — the prover re-adds the legs and checks this table agrees, and the legs win
-- if they ever disagree.
--
-- Every CHECK constraint here also exists as a rule in the TypeScript code; the database
-- enforces the same invariant a second time as a safety net. All money is a whole number
-- of minor units (cents for USD, 1 for a credit) in BIGINT columns; the database drivers
-- return these as JavaScript BigInt, never as a floating-point number.
--
-- Apply this file once, by hand or in CI — it declares the current shape outright, with no
-- migration steps, no `if not exists`, and no backfills. It is never run on app startup.

-- ============================================================================
-- Accounts: the list of accounts money can be posted to. The platform's own "system"
-- accounts are seeded just below; a user's accounts are created the first time something
-- is posted to them. `kind` says what sort of account it is, and `currency` fixes whether
-- it holds CREDIT or USD, so a posting can check that all of its legs use one currency.
-- ============================================================================
create table accounts (
  id         text        primary key,
  kind       text        not null check (kind in ('spendable', 'earned', 'promo', 'system')),
  currency   text        not null check (currency in ('CREDIT', 'USD')),
  created_at timestamptz not null default now()
);

-- The platform's own accounts, inserted once here. A user's accounts (named
-- `usr_<uuid>:<kind>`) are created on first posting, so they need no seed row.
insert into accounts (id, kind, currency) values
  ('vrchat:trust_cash',     'system', 'USD'),
  ('vrchat:revenue',        'system', 'CREDIT'),
  ('vrchat:stored_value',   'system', 'CREDIT'),
  ('vrchat:payout_reserve', 'system', 'CREDIT'),
  ('vrchat:receivable',     'system', 'CREDIT'),
  ('vrchat:promo_float',    'system', 'CREDIT'),
  ('vrchat:usd_clearing',   'system', 'USD'),
  ('vrchat:revenue_usd',    'system', 'USD'),
  ('vrchat:opening_equity', 'system', 'CREDIT');

-- ============================================================================
-- Postings are the append-only record of everything that happened. Each posting is split
-- into its individual debit/credit lines ("legs") in the `legs` table, and into one
-- hash-chain link per account it touches in `chain_links`. A leg's amount is stored signed
-- — a debit is positive, a credit negative — so that across the whole ledger the legs sum
-- to zero in each currency when the books balance, which is exactly what the conservation
-- check verifies.
-- ============================================================================
create table postings (
  id         text        primary key,                      -- transaction id, like txn_<uuid>
  meta       jsonb       not null default '{}',
  posted_at  bigint      not null,                          -- commit time, in epoch milliseconds
  seq        bigserial   unique,                            -- ever-increasing number giving postings a total order
  created_at timestamptz not null default now()
);

-- One leg = one debit or credit line of a posting. The amount is signed (debit positive,
-- credit negative) and may never be zero (a zero leg would be a do-nothing posting, i.e. a
-- bug). A single posting can have SEVERAL legs to the SAME account — e.g. a promo-funded
-- spend credits a seller twice, once from revenue and once from the fee split — which is
-- why the hash-chain link lives in `chain_links` (one per account), not on each leg.
create table legs (
  id         bigserial   primary key,
  posting_id text        not null references postings (id),
  account_id text        not null references accounts (id),
  currency   text        not null check (currency in ('CREDIT', 'USD')),
  amount     bigint      not null check (amount <> 0)
);
create index legs_account_idx on legs (account_id);
create index legs_posting_idx on legs (posting_id);

-- One hash-chain link per (posting, account): each posting advances an account's chain
-- exactly once, no matter how many legs it has to that account. The link records the
-- previous hash and the new hash for that account. The hash is computed from the previous
-- hash, the transaction id, that account's legs, and the posting metadata — 64 lowercase
-- hex characters, computed in application code (never in SQL) over the account's whole set
-- of legs in this posting. Keeping the link separate from the legs is what lets a posting
-- hold several same-account legs while the recomputed hash still covers the identical set
-- of legs the in-memory reference implementation uses.
create table chain_links (
  posting_id text        not null references postings (id),
  account_id text        not null references accounts (id),
  prev_hash  text        not null,                          -- previous hash, 64 lowercase hex; the first link uses 32 zero bytes
  hash       text        not null,                          -- the new hash, 64 lowercase hex
  -- One link per account per posting: a posting advances an account's chain exactly once.
  primary key (posting_id, account_id)
);
create index chain_links_account_idx on chain_links (account_id);
-- Each previous-hash can be used only once per account, so two different postings can't
-- both attach at the same point and fork an account's chain into two branches.
create unique index chain_links_account_prev_uq on chain_links (account_id, prev_hash);

-- ============================================================================
-- The cached per-account balances — the fast read model, updated in the SAME transaction
-- as the legs that change it. It is always re-derivable from the legs and is never the
-- source of truth. The non-negative CHECK below is the database's half of the overdraft
-- guard: a real user's account may never drop below zero. The platform's own accounts are
-- exempt, because several of them legitimately hold negative balances by design.
-- ============================================================================
create table account_balances (
  account_id text   not null primary key references accounts (id),
  currency   text   not null check (currency in ('CREDIT', 'USD')),
  balance    bigint not null default 0,
  -- A user account (`usr_…:<kind>`) may never go negative; a system account may.
  constraint user_account_non_negative
    check (account_id like 'vrchat:%' or balance >= 0)
);

-- ============================================================================
-- Idempotency: makes a retried request safe to run twice. The key is the primary key, so
-- the database itself prevents duplicates. A request claims its key here when it starts; a
-- second request with the same key waits for the first to finish, then replays the first
-- one's recorded result instead of doing the work again. If the first request rolled back
-- it left no row, so a fresh retry is allowed to proceed.
-- ============================================================================
create table idempotency (
  key         text        primary key,
  transaction jsonb       not null,                         -- the recorded result, replayed verbatim on a duplicate
  created_at  timestamptz not null default now()
);

-- ============================================================================
-- Webhook replay dedup: the boundary's own exactly-once guard for inbound provider
-- callbacks, kept in its own namespace from the domain's `idempotency` table so the two
-- layers can never collide on a shared key. A verified webhook claims its provider event id
-- here as the LAST gate (after the HMAC and freshness checks), so a forged or stale delivery
-- that fails an earlier check never burns the id and a later genuine delivery still credits.
-- The event id being the primary key IS the dedup: a second delivery of the same id finds the
-- row already present and does no work.
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
-- Outbox: events waiting to be published, written in the SAME transaction as the ledger
-- change that caused them, so an event and its ledger effect always exist together. A
-- background relay grabs a batch (locking those rows so workers don't collide), publishes
-- them, and marks them relayed; a consumer may see an event more than once, so it dedupes
-- on the event id. The partial index keeps the "find pending rows" scan fast.
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
-- Payouts: a multi-step process (a "saga") that moves a creator's earned credits out to
-- real money. Only the background worker advances it, never a normal request. `reserve` is
-- the amount of earned credit set aside for this payout; `rate_id` pins the credit-to-USD
-- rate used, so the settlement can be reproduced and disputed later.
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
-- The worker's "find due payouts" scan only looks at RESERVED and SUBMITTED rows. A payout
-- becomes RESERVED in the same request that opens it, so a row still in REQUESTED at scan
-- time means that request crashed partway — the worker deliberately skips it rather than
-- picking up a half-finished payout forever. The CHECK above still allows all five states;
-- only this index (and the matching query in the code) narrow it to the two scannable ones.
create index payout_sagas_due_idx on payout_sagas (due_at)
  where state in ('RESERVED', 'SUBMITTED');

-- ============================================================================
-- Promo grants: one row per promotional credit handed out. It shares the id of the posting
-- that granted it, so re-running the grant is harmless. A background sweep finds grants
-- that are past their expiry and not yet reversed, oldest first, reverses whatever the user
-- didn't spend, then sets `reversed` so each grant is reversed at most once. `amount` is the
-- full original grant in minor units.
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
-- Entitlements: what a user owns (access to a SKU), tracked separately from the money
-- ledger. A user has at most one row per SKU. A null `expires_at` means it never lapses;
-- `revoked` is set when a refund or clawback takes the entitlement away.
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
-- Subscriptions: recurring charges. Each billing period uses its own idempotency key, so
-- the renewal sweep can safely retry. This row holds the subscription's current state;
-- `next_due_at` is what the "find subscriptions due to bill" scan reads.
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
-- Velocity / risk log: one row per attempt, used to add up how much a subject has tried to
-- spend over a recent time window. These rows are written OUTSIDE the normal transaction
-- rollback, on purpose: even an attempt that was rejected still counts, so a burst of
-- declines (a likely fraud signal) is not free. Keyed on the idempotency key so a genuine
-- retry isn't counted twice.
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
-- Checkpoints: a signed snapshot of the whole ledger's state. Each row holds a Merkle root
-- (a single hash that summarizes every account's latest hash) plus a signature made with a
-- key the ledger writer can't reach. That way even an insider who rewrites a whole account
-- history and recomputes its hashes is caught: the new root no longer matches the old
-- signature. `root` and `signature` are lowercase hex. In production this table lives in a
-- separate, tamper-proof store.
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
-- Stored routines. These are PURE PERSISTENCE — no business logic. Every decision (which way
-- each account moves, the per-account net delta, the chain hashes, the account kind) is made in
-- the application, the single source of truth, and passed in as a finished value; the routines
-- only write rows. They exist for scale and stability: a posting that was a dozen-plus network
-- round-trips (one INSERT/UPSERT per leg, link, and balance) collapses to ONE `call`, and the
-- multi-row writes run as one set-based unit inside the caller's transaction.
-- ============================================================================

-- Persist one posting and everything derived from it in a single call: ensure any first-time
-- user accounts (system accounts are seeded above), insert the posting row, all of its legs, one
-- chain link per account, and apply each account's net balance delta. bigint amounts arrive as
-- JSON strings (so no precision is lost past 2^53) and are cast here. The balance step UPDATEs
-- existing rows first — so the non-negative CHECK is evaluated against the new total, not the
-- delta alone — then INSERTs first-time accounts, whose first movement is always a positive credit.
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
-- statement and prove paths build on; wrapping it as a function gives the read one named,
-- tunable access path.
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
