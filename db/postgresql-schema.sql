-- @pwngh/economy-lab
--
-- Copyright (c) Preston Neal
--
-- This source code is licensed under the MIT license found in the
-- LICENSE.md file in the root directory of this source tree.
--
-- @license MIT

-- Apply once, by hand or in CI: no migrations, no backfills, never on app startup. The ledger
-- is append-only — an account's balance is the sum of its legs, and the legs win when the
-- cached balance disagrees. Money is whole minor units in BIGINT columns; drivers return these
-- as JS BigInt, never float.

-- ============================================================================
-- Accounts money can be posted to. `currency` fixes whether an account holds CREDIT or USD.
-- ============================================================================
create table accounts (
  id         text        primary key,
  kind       text        not null check (kind in ('spendable', 'earned', 'promo', 'system')),
  currency   text        not null check (currency in ('CREDIT', 'USD')),
  created_at timestamptz not null default now(),
  -- Lets legs carry a composite FK to (id, currency), so a leg's currency must match its account's.
  unique (id, currency)
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
  ('platform:opening_equity', 'system', 'CREDIT'),
  ('platform:netting_clearing', 'system', 'CREDIT');

-- ============================================================================
-- Postings: the append-only record of everything that happened. Each posting splits into
-- legs in `legs`, plus one hash-chain link per touched account in `chain_links`.
-- ============================================================================
create table postings (
  id         text        primary key,
  meta       jsonb       not null default '{}',
  posted_at  bigint      not null,
  seq        bigserial   unique,
  created_at timestamptz not null default now()
);

-- One leg = one debit or credit line of a posting. Amount is signed (debit positive, credit
-- negative) and never zero. A posting can hold several legs to the same account, so the
-- hash-chain link lives in `chain_links` (one per account), not on each leg.
create table legs (
  id         bigserial   primary key,
  posting_id text        not null references postings (id),
  account_id text        not null,
  currency   text        not null check (currency in ('CREDIT', 'USD')),
  amount     bigint      not null check (amount <> 0),
  -- Composite FK to accounts(id, currency): a leg's currency must match its account's, enforced
  -- natively. Rejects a raw cross-currency leg (e.g. balanced USD legs on CREDIT accounts) that the
  -- per-currency conservation check would let pass. Subsumes the plain account_id reference.
  foreign key (account_id, currency) references accounts (id, currency)
);
-- Serves the maturity tail's newest-first read: legs.id is a bigserial in commit order, so
-- ordering by it needs no sort, and leading account_id replaces a bare legs(account_id) index.
-- INCLUDE carries currency and amount so the prover's per-account sum is an index-only scan.
create index legs_account_idx on legs (account_id, id) include (currency, amount);
create index legs_posting_idx on legs (posting_id);

-- One hash-chain link per (posting, account): each posting advances an account's chain once,
-- however many legs touch it. The hash is computed in application code (src/chain.ts), never in SQL.
create table chain_links (
  posting_id text        not null references postings (id),
  account_id text        not null references accounts (id),
  prev_hash  text        not null,
  hash       text        not null,
  -- The account's signed running balance right after this link, the same figure post_entry writes into
  -- account_balances.balance, so the balance-integrity check compares cached balance to chain head in
  -- O(1) instead of re-summing legs. A projection, not the source of truth: prove() re-sums and wins.
  balance_after bigint   not null default 0,
  primary key (posting_id, account_id)
);
create index chain_links_account_idx on chain_links (account_id);
-- A previous-hash can be used only once per account, so two postings can't both attach at
-- the same point and fork the chain into two branches. MySQL keys this same guard by a digest
-- of the pair; db/mysql-schema.sql says why.
create unique index chain_links_account_prev_uq on chain_links (account_id, prev_hash);
-- The continuity trigger looks up an account's current head by (account_id, hash); without
-- this every insert scans that account's whole chain.
create index chain_links_account_hash_idx on chain_links (account_id, hash);

-- ============================================================================
-- Cached per-account balances: the fast read model, updated in the same transaction as the
-- legs that change it. Always re-derivable from the legs, never the source of truth.
-- ============================================================================
create table account_balances (
  account_id text   not null primary key references accounts (id),
  currency   text   not null check (currency in ('CREDIT', 'USD')),
  balance    bigint not null default 0,
  -- Chain-head pointer: hash of this account's latest chain_links row, written with the balance by
  -- post_entry, so headsForAccounts reads each head by primary key instead of scanning and sorting. A
  -- projection (chain_links stays source of truth); defaults to the genesis hash (64 zeros).
  head_hash  text   not null default repeat('0', 64),
  -- The DB half of the overdraft guard: a user account may never go negative. System
  -- accounts are exempt; several hold negative balances by design.
  constraint user_account_non_negative
    check (account_id like 'platform:%' or balance >= 0)
);

-- Pre-plant an empty balance row (reads identically to no row) for each system account, so lockAccounts
-- can take `for update` on it. Without it, concurrent writers to a hot shared account (STORED_VALUE,
-- touched by every top-up) find no row to lock, so none wait and they race to extend the chain head and
-- collide. User accounts create their row on first posting; the chain-fork retry covers that rarer race.
insert into account_balances (account_id, currency, balance, head_hash)
  select id, currency, 0, repeat('0', 64) from accounts where kind = 'system';

-- ============================================================================
-- Idempotency: the key is the primary key, so the DB itself blocks a duplicate run.
-- See https://economy-lab-docs.pages.dev/economy/concepts/idempotency/ for the claim/record model.
-- ============================================================================
create table idempotency (
  key         text        primary key,
  -- NOT NULL because PG claims via an advisory lock (pg_advisory_xact_lock), so the row is only
  -- ever written with a result, never a placeholder.
  transaction jsonb       not null,
  created_at  timestamptz not null default now()
);

-- ============================================================================
-- Webhook replay dedup, separate from `idempotency` so the two layers can't collide on a shared
-- key. The event id is claimed as the LAST gate, after HMAC and freshness, so a forged or stale
-- delivery never burns the id.
-- See https://economy-lab-docs.pages.dev/economy/reference/http-service/ for the verification gate.
-- ============================================================================
create table seen_webhooks (
  event_id text        primary key,
  seen_at  timestamptz not null default now()
);

-- ============================================================================
-- Sales: a summary of each purchase, keyed by its order id (separate from the idempotency
-- key) so a refund can reverse exactly what was posted. `legs` stores the posted lines as
-- decimal-string amounts so they round-trip exactly.
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
-- publishes pending rows at-least-once; consumers dedupe on event id.
-- See https://economy-lab-docs.pages.dev/economy/ports/messaging/ for the outbox+inbox.
-- ============================================================================
create table outbox (
  id                 text        primary key,
  event              jsonb       not null,
  status             text        not null default 'pending'
                       check (status in ('pending', 'relayed', 'dead')),
  attempts           int         not null default 0,
  dead_letter_reason text,
  correlation_id     text,                                  -- id of the request that enqueued this event; null for worker-born events
  created_at         timestamptz not null default now()
);
create index outbox_pending_idx on outbox (created_at) where status = 'pending';

-- ============================================================================
-- Inbox: the inbound mirror of `outbox`. A verified provider event, mapped to the operation it
-- should apply, is written in the same transaction as the webhook ingress that claimed it.
-- `key` is the provider event id, so redelivery is a no-op insert, applied at most once.
-- See https://economy-lab-docs.pages.dev/economy/ports/messaging/ for the outbox+inbox.
-- ============================================================================
create table inbox (
  id                 text        primary key,
  key                text        not null unique,            -- the provider's event id: dedupe + the operation's idempotencyKey
  operation          jsonb       not null,
  status             text        not null default 'pending'
                       check (status in ('pending', 'applied', 'dead')),
  attempts           int         not null default 0,
  dead_letter_reason text,
  received_at        bigint      not null,
  created_at         timestamptz not null default now()
);
create index inbox_pending_idx on inbox (received_at) where status = 'pending';

-- ============================================================================
-- Payouts: a multi-step saga that moves a seller's earned credits out to real money. Only the
-- background worker advances it, never a normal request. `rate_id` pins the CREDIT-to-USD rate
-- so the settlement can be reproduced and disputed later.
-- ============================================================================
create table payout_sagas (
  id                 text   primary key,
  user_id            text   not null,
  reserve            bigint not null check (reserve > 0),
  rate_id            text   not null,
  -- The reserve posting this saga opened with. The saga row is unhashed and drives real USD out,
  -- so every money-moving step re-proves the row against this posting's sealed metadata and legs
  -- before acting. Required: a saga without its anchor cannot move money.
  txn_id             text   not null,
  state              text   not null
                       check (state in ('REQUESTED', 'RESERVED', 'SUBMITTED', 'SETTLED', 'FAILED')),
  provider_ref       text,
  attempts           int    not null default 0,
  -- `reason` is the terminal failure outcome, null until FAILED. `payout_usd` is the USD quote
  -- priced at request (also sealed in the anchor posting's metadata). The settle patch re-records
  -- the disbursed gross on it.
  reason             text,
  payout_usd         bigint,
  due_at             bigint not null,
  updated_at         bigint not null
);
-- The worker's due-payouts scan only looks at RESERVED and SUBMITTED rows; a row still in REQUESTED
-- means its opening request crashed partway, so the worker skips it rather than picking up a
-- half-finished payout forever.
create index payout_sagas_due_idx on payout_sagas (due_at)
  where state in ('RESERVED', 'SUBMITTED');
-- Serves requestPayout's min-interval gate: max(updated_at) for one user across all their sagas.
create index payout_sagas_user_updated_idx on payout_sagas (user_id, updated_at);
-- A provider callback names a payout by provider_ref, so the inbound-webhook lookup reads by it.
-- Partial: provider_ref stays null until submit, and callbacks only reference submitted payouts.
create index payout_sagas_provider_ref_idx on payout_sagas (provider_ref)
  where provider_ref is not null;

-- ============================================================================
-- Promo grants: one row per promotional credit handed out. Shares the id of the posting that
-- granted it, so re-running the grant is harmless. The expiry sweep reverses whatever the user
-- didn't spend, then sets `reversed` so each grant reverses at most once.
-- ============================================================================
create table promo_grants (
  id         text   primary key,
  user_id    text   not null,
  amount     bigint not null check (amount >= 0),
  currency   text   not null check (currency in ('CREDIT', 'USD')),
  expires_at bigint not null,
  reversed   boolean not null default false
);
create index promo_grants_due_idx on promo_grants (expires_at) where reversed = false;

-- ============================================================================
-- Entitlements: what a user owns (access to a SKU), tracked separately from the money ledger.
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
-- renewal sweep can safely retry.
-- ============================================================================
create table subscriptions (
  id           text   primary key,
  user_id      text   not null,
  seller_id    text   not null,
  sku          text   not null,
  price        bigint not null check (price > 0),
  -- The first-charge posting, whose sealed metadata the renewal sweep re-proves the row against
  -- before every charge. Required: a nullable anchor would be an anchor an attacker can remove.
  -- An upgrading deployment re-anchors live rows by posting one anchor entry per subscription.
  txn_id       text   not null,
  period_ms    bigint not null check (period_ms > 0),
  state        text   not null check (state in ('ACTIVE', 'LAPSED', 'CANCELED')),
  period       int    not null default 1,
  -- At the configured failure limit the renewal sweep marks the subscription LAPSED.
  attempts     int    not null default 0,
  next_due_at  bigint not null,
  updated_at   bigint not null
);
create index subscriptions_due_idx on subscriptions (next_due_at) where state = 'ACTIVE';
-- Serves subscribe's duplicate guard: the activeFor lookup by (user_id, sku, seller_id).
create index subscriptions_user_sku_seller_idx on subscriptions (user_id, sku, seller_id);

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
-- The append-only per-instance journal behind netting (src/netting.ts). A movement is ACCEPTED
-- iff its row committed; the in-memory net map is a cache of this table. Rows are hash-chained
-- per session (prev_hash/hash) and the settlement posting's meta anchors the final head, so
-- tamper-evidence extends transitively from the proved ledger to every movement. idem_key is the
-- per-movement idempotency layer; (session_id, seq) makes a forked position impossible to store.
-- ============================================================================
create table instance_movements (
  id          bigserial   primary key,
  session_id  text        not null,
  seq         integer     not null,
  idem_key    text        not null unique,
  legs        jsonb       not null,                          -- balanced legs, amounts as encoded strings
  prev_hash   text        not null,                          -- session chain hash before; genesis is zeros
  hash        text        not null,
  recorded_at bigint      not null,
  unique (session_id, seq)
);

-- ============================================================================
-- Seal heads: the latest checkpoint's Merkle leaves, one row per account — each account's chain
-- head and raw signed leg sum as of the last seal. The incremental seal re-derives this table's
-- Merkle root and checks it against the latest signed checkpoint before trusting a byte of it,
-- then re-proves only the accounts whose live heads moved. Upserted per account at each seal.
-- ============================================================================
create table seal_heads (
  account_id text   primary key,
  head       text   not null,
  sum        bigint not null
);
-- ============================================================================
-- Checkpoints: a signed snapshot of ledger state. Each row holds a Merkle root over every account's
-- latest hash, signed with a key the ledger writer can't reach, so an insider who rewrites a history
-- and recomputes its hashes is caught: the new root no longer matches the old signature. In production
-- this table lives in a separate, tamper-proof store.
-- ============================================================================
create table checkpoints (
  id         text        primary key,
  root       text        not null,                          -- lowercase hex Merkle root (v2: over hashes and sums)
  signature  text        not null,                          -- lowercase hex (v1: over the root; v2: over root and sum)
  count      bigint      not null,
  at         bigint      not null,
  v          smallint    not null default 1,                -- preimage construction; pre-versioning rows are 1
  sum        text,                                          -- signed decimal minor-unit sum under a v2 root; null on v1 rows
  kid        text,                                          -- id of the signing key that sealed the row; null before kid stamping
  seq        bigserial   unique,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- Stored routines (persistence) plus the engine's invariant enforcement. The application computes a
-- posting's values and passes them in finished; these routines write the rows in one set-based `call`
-- inside the caller's transaction. The database is the primary enforcer, not a safety net: the CHECKs
-- above plus the triggers at the end of this file reject any write that violates conservation,
-- no-overdraft, chain continuity, exactly-once, or balance integrity, even one that bypasses the app
-- entirely. The app keeps the same checks only as friendly pre-checks that return a kind error.
-- See https://economy-lab-docs.pages.dev/economy/concepts/integrity/ for the invariants.
-- ============================================================================

-- Persist one posting and everything derived from it in a single call: first-time user accounts, the
-- posting row, its legs, one chain link per account, and each account's net balance delta. bigint
-- amounts arrive as JSON strings (no precision lost past 2^53) and are cast here.
create procedure post_entry(
  p_txn          text,
  p_posted_at    bigint,
  p_meta         jsonb,
  p_legs         jsonb,   -- [{account, currency, amount}]   raw signed: debit +, credit -
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

  -- One link per distinct account, carrying its signed running balance after this posting: the current
  -- cached balance (0 for a first-time account) plus this posting's net delta. account_balances still
  -- holds the OLD balance here (the balance step runs after), so by construction this equals what that
  -- step writes into account_balances.balance, which the balance-integrity trigger later compares.
  insert into chain_links (posting_id, account_id, prev_hash, hash, balance_after)
    select p_txn, c.account, c.prev_hash, c.hash,
           coalesce(ab.balance, 0) + d.delta::bigint
      from jsonb_to_recordset(p_links) as c(account text, prev_hash text, hash text)
      join jsonb_to_recordset(p_balances) as d(account text, currency text, delta text)
        on d.account = c.account
      left join account_balances ab on ab.account_id = c.account;

  -- p_links carries one row per distinct account (the same set as p_balances), so the join pairs
  -- each balance row with its new head. UPDATE existing rows first so the non-negative CHECK
  -- tests the new total, not the delta alone.
  update account_balances ab
     set balance = ab.balance + d.delta::bigint,
         head_hash = c.hash
    from jsonb_to_recordset(p_balances) as d(account text, currency text, delta text)
    join jsonb_to_recordset(p_links) as c(account text, prev_hash text, hash text)
      on c.account = d.account
   where ab.account_id = d.account;

  insert into account_balances (account_id, currency, balance, head_hash)
    select d.account, d.currency, d.delta::bigint, c.hash
      from jsonb_to_recordset(p_balances) as d(account text, currency text, delta text)
      join jsonb_to_recordset(p_links) as c(account text, prev_hash text, hash text)
        on c.account = d.account
     where not exists (
       select 1 from account_balances ab where ab.account_id = d.account
     )
    on conflict (account_id)
      do update set balance = account_balances.balance + excluded.balance,
                    head_hash = excluded.head_hash;
end;
$$;

-- Returns one account's cached balance, 0 when it has no row yet.
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
-- chain continuity. The unique index above blocks a FORK (a second link at the
-- same prev_hash); this blocks a DISCONTINUOUS link: a new link's prev_hash must be the account's
-- current head (GENESIS for the first link, else an existing link's hash). The legitimate writer
-- (advanceHeads, src/chain.ts) always supplies the head, so this only rejects a link written around
-- post_entry.
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
-- DEFERRABLE INITIALLY DEFERRED constraint trigger checks at COMMIT, so post_entry can insert all of a
-- posting's balanced legs first, while a lone unbalanced leg written around the app fails at commit.
-- The engine half of assertBalanced (src/ledger.ts), which the app keeps as the friendly pre-check.
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
-- balance integrity (Postgres). post_entry writes an account's running total into
-- both account_balances.balance and its head chain_links row's balance_after, so this trigger checks
-- the cheap equivalent: cached balance must equal balance_after at the head (hash = head_hash) — an
-- O(1) keyed read (chain_links_account_hash_idx) instead of re-summing legs. It still rejects a
-- hand-edited balance: a raw UPDATE bumping balance leaves head_hash and balance_after untouched, so the
-- two disagree. A head_hash with no matching link yields expected = 0, so only a zero (genesis) passes.
-- ============================================================================
create or replace function check_balance_integrity() returns trigger as $$
declare
  expected bigint;
begin
  expected := coalesce(
    (select balance_after from chain_links
      where account_id = new.account_id and hash = new.head_hash),
    0
  );
  if new.balance <> expected then
    raise exception 'balance integrity: account % cached balance % <> chain head balance %',
      new.account_id, new.balance, expected;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace trigger account_balances_integrity
  before insert or update on account_balances
  for each row execute function check_balance_integrity();

-- ============================================================================
-- Schema version stamp. The engine reads this row on startup and refuses to run if it does not match
-- SCHEMA_VERSION in src/schema.ts, so a database left on an older schema fails loudly instead of
-- being silently misread. Bump the value here, in the MySQL schema's matching insert, and in
-- src/schema.ts together, whenever this file changes.
-- ============================================================================
create table schema_meta (version text not null);
insert into schema_meta (version) values ('12');

-- Deployed at-a-glance column docs (visible via \d+); the banners above carry the depth.
comment on column accounts.id is 'Account id; platform:<name> or usr_<uuid>:<kind>.';
comment on column accounts.kind is 'One of spendable, earned, promo, system.';
comment on column accounts.currency is 'One of CREDIT or USD.';
comment on column accounts.created_at is 'UTC time the row was inserted.';
comment on column postings.id is 'Transaction id, like txn_<uuid>.';
comment on column postings.meta is 'JSON metadata bag for the posting.';
comment on column postings.posted_at is 'Commit time in epoch milliseconds.';
comment on column postings.seq is 'Auto-increment sequence giving postings a total order.';
comment on column postings.created_at is 'UTC time the row was inserted.';
comment on column legs.id is 'Auto-increment leg id in commit order.';
comment on column legs.posting_id is 'Parent posting id; FK to postings.';
comment on column legs.account_id is 'Account this leg debits or credits.';
comment on column legs.currency is 'One of CREDIT or USD; must match account.';
comment on column legs.amount is 'Signed minor units: debit positive, credit negative; never zero.';
comment on column chain_links.posting_id is 'Posting that advanced this account chain; FK to postings.';
comment on column chain_links.account_id is 'Account whose hash chain this link extends; FK to accounts.';
comment on column chain_links.prev_hash is 'Previous chain hash, 64 lowercase hex; genesis is zeros.';
comment on column chain_links.hash is 'This link''s new chain hash, 64 lowercase hex.';
comment on column chain_links.balance_after is 'Signed running balance right after this link; cached projection.';
comment on column account_balances.account_id is 'Account this cached balance is for; PK and FK to accounts.';
comment on column account_balances.currency is 'Currency of the balance: CREDIT or USD.';
comment on column account_balances.balance is 'Cached signed balance in minor units; user accounts stay non-negative.';
comment on column account_balances.head_hash is 'Hash of this account''s latest chain_links row; defaults to genesis zeros.';
comment on column idempotency."key" is 'Idempotency key; PK that blocks duplicate request execution.';
comment on column idempotency.transaction is 'Recorded result, replayed verbatim on a duplicate request.';
comment on column idempotency.created_at is 'UTC time the row was inserted.';
comment on column sales.order_id is 'Order id; primary key, distinct from idempotency key.';
comment on column sales.buyer_id is 'Account that paid for the purchase.';
comment on column sales.recipient_id is 'Account receiving the item; null if buyer.';
comment on column sales.sku is 'Catalog item code that was purchased.';
comment on column sales.price is 'Purchase price in minor units; always positive.';
comment on column sales.fee is 'Platform fee in minor units; zero or more.';
comment on column sales.legs is 'Posted lines as decimal strings for exact replay.';
comment on column sales.txn_id is 'Posting transaction id; references postings.id.';
comment on column sales.posted_at is 'When the sale posted, epoch ms.';
comment on column outbox.id is 'Outbox row id; primary key, obx_<uuid>.';
comment on column outbox.event is 'JSON event payload to publish.';
comment on column outbox.status is 'One of pending, relayed, dead.';
comment on column outbox.attempts is 'Number of publish attempts so far.';
comment on column outbox.dead_letter_reason is 'Last error code if dead; else null.';
comment on column outbox.created_at is 'UTC time the row was inserted.';
comment on column inbox.id is 'Inbox row id; primary key, ibx_<uuid>.';
comment on column inbox."key" is 'Provider event id; unique, dedupes redelivery.';
comment on column inbox.operation is 'Serialized Operation to submit, as JSON.';
comment on column inbox.status is 'One of pending, applied, dead.';
comment on column inbox.attempts is 'Number of apply attempts so far.';
comment on column inbox.dead_letter_reason is 'Last error code if dead; else null.';
comment on column inbox.received_at is 'When the event was enqueued, epoch ms.';
comment on column inbox.created_at is 'UTC time the row was inserted.';
comment on column payout_sagas.id is 'Saga primary key, pay_ prefixed uuid.';
comment on column payout_sagas.user_id is 'Creator the payout belongs to.';
comment on column payout_sagas.reserve is 'Earned credits set aside; always positive.';
comment on column payout_sagas.rate_id is 'Pinned CREDIT-to-USD rate for this settlement.';
comment on column payout_sagas.state is 'One of REQUESTED, RESERVED, SUBMITTED, SETTLED, FAILED.';
comment on column payout_sagas.provider_ref is 'Payout provider reference; null until submitted.';
comment on column payout_sagas.attempts is 'Consecutive worker attempt count.';
comment on column payout_sagas.reason is 'Failure reason set when dead-lettered; null otherwise.';
comment on column payout_sagas.payout_usd is 'Gross USD disbursed; null until SETTLED.';
comment on column payout_sagas.due_at is 'Epoch ms when the worker may next advance it.';
comment on column payout_sagas.updated_at is 'Epoch ms the row was last updated.';
comment on column promo_grants.id is 'Primary key, txn_ uuid shared with the posting.';
comment on column promo_grants.user_id is 'User the promotional credit was granted to.';
comment on column promo_grants.amount is 'Full original grant in minor units; non-negative.';
comment on column promo_grants.currency is 'CREDIT or USD; always CREDIT in practice.';
comment on column promo_grants.expires_at is 'Epoch ms the grant expires.';
comment on column promo_grants.reversed is 'True once the unspent remainder was reversed.';
comment on column entitlements.user_id is 'Owner of the entitlement; part of primary key.';
comment on column entitlements.sku is 'SKU the user owns; part of primary key.';
comment on column entitlements.quantity is 'Units owned; non-negative.';
comment on column entitlements.version is 'Optimistic-lock version, bumped on each change.';
comment on column entitlements.expires_at is 'Epoch ms it lapses; null never lapses.';
comment on column entitlements.revoked is 'True when a refund or clawback removed it.';
comment on column entitlements.source is 'What granted the entitlement; nullable.';
comment on column entitlements.granted_at is 'UTC time the entitlement was granted.';
comment on column subscriptions.id is 'Subscription id, sub_<uuid>; primary key.';
comment on column subscriptions.user_id is 'Buyer charged each billing period.';
comment on column subscriptions.seller_id is 'Seller credited each billing period.';
comment on column subscriptions.sku is 'Product identifier being subscribed to.';
comment on column subscriptions.price is 'Per-period charge in minor units; always positive.';
comment on column subscriptions.period_ms is 'Billing interval length in milliseconds; always positive.';
comment on column subscriptions.state is 'One of ACTIVE, LAPSED, CANCELED.';
comment on column subscriptions.period is 'Billing-cycle counter; renewal bills period plus one.';
comment on column subscriptions.attempts is 'Consecutive failed charges; reset to 0 on success.';
comment on column subscriptions.next_due_at is 'Epoch ms when the next charge is due.';
comment on column subscriptions.updated_at is 'Epoch ms of the last update.';
comment on column trust_attempts.idempotency_key is 'Attempt idempotency key; primary key, dedupes retries.';
comment on column trust_attempts.subject is 'Identity whose spend velocity is summed.';
comment on column trust_attempts.amount is 'Attempted spend in minor units.';
comment on column trust_attempts.outcome is 'One of committed, rejected.';
comment on column trust_attempts.at is 'Epoch ms the attempt was recorded.';
comment on column checkpoints.id is 'Checkpoint id, chk_<uuid>; primary key.';
comment on column checkpoints.root is 'Merkle root over account hashes; lowercase hex.';
comment on column checkpoints.signature is 'Signature over the root; lowercase hex.';
comment on column checkpoints.count is 'How many account hashes this root covers.';
comment on column checkpoints.at is 'Epoch ms the checkpoint was taken.';
comment on column checkpoints.kid is 'Id of the signing key that sealed the row; null before kid stamping.';
comment on column checkpoints.seq is 'Monotonic sequence number; unique, auto-assigned.';
comment on column checkpoints.created_at is 'UTC time the row was inserted.';
comment on column seen_webhooks.event_id is 'Provider stable event id; primary key for replay dedup.';
comment on column seen_webhooks.seen_at is 'UTC time this event id was first claimed.';
comment on column schema_meta.version is 'Schema version stamp; must match SCHEMA_VERSION at startup.';

comment on table accounts is 'Every account money posts to: user wallets and the platform accounts.';
comment on table postings is 'Append-only record of every posting; one balanced set of legs each.';
comment on table legs is 'The signed debit/credit lines that make up each posting.';
comment on table chain_links is 'Per-account hash-chain links that make the ledger tamper-evident.';
comment on table account_balances is 'Cached per-account balance read model; re-derivable from the legs.';
comment on table idempotency is 'Exactly-once guard recording each operation outcome by key.';
comment on table sales is 'Summary of each purchase, keyed by its order id.';
comment on table outbox is 'Pending outbound events awaiting relay to the dispatcher.';
comment on table inbox is 'Verified inbound provider events awaiting apply by the worker.';
comment on table payout_sagas is 'Payout state machine: one row per seller cash-out.';
comment on table promo_grants is 'Promotional credit grants with their expiry and reversal state.';
comment on table entitlements is 'What each user owns (SKU ownership), with version and expiry.';
comment on table subscriptions is 'Recurring charges: one row per subscription and its billing state.';
comment on table trust_attempts is 'Per-key spend attempts feeding the velocity and risk check.';
comment on table seal_heads is 'Latest checkpoint leaves per account; the incremental seal authenticates then diffs against it.';
comment on table checkpoints is 'Signed Merkle checkpoints over the per-account hash chains.';
comment on table seen_webhooks is 'Replay-dedup guard for inbound provider webhooks, by event id.';
comment on table schema_meta is 'Single-row schema version stamp, checked at startup.';
