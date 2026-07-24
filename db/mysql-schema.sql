-- @pwngh/economy-lab
--
-- Copyright (c) Preston Neal
--
-- This source code is licensed under the MIT license found in the
-- LICENSE.md file in the root directory of this source tree.
--
-- @license MIT

-- MySQL counterpart to db/postgresql-schema.sql. Applied by `applyMysqlSchema`
-- (src/engines/mysql.ts) via a DELIMITER-aware splitter that runs one statement at a time.
-- Drops everything up front, so re-running resets.
--
-- MySQL has no partial index, so each Postgres partial-index predicate folds into the leading
-- column of the composite key (the *_pending_idx and *_due_idx lead with the filtered column).

-- Pin the database default collation FIRST so every table inherits it: JSON_TABLE inside
-- post_entry produces utf8mb4_0900_ai_ci strings, and matching table collations avoid an
-- "Illegal mix of collations" error on its joins. Applying by hand: this mutates the current
-- database's default, so USE the target database first. The collation needs MySQL 8.0+.
ALTER DATABASE CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Drop stored routines first: unlike DROP TABLE they have no IF-EXISTS-on-CREATE form, so re-apply
-- fails with ER_SP_ALREADY_EXISTS without an explicit drop. (CREATE TABLE below is guarded by the
-- DROP TABLEs.)
DROP PROCEDURE IF EXISTS post_entry;

DROP PROCEDURE IF EXISTS post_entries;
DROP PROCEDURE IF EXISTS trust_record;

DROP FUNCTION IF EXISTS account_balance;

DROP TRIGGER IF EXISTS chain_links_continuity;

DROP TRIGGER IF EXISTS account_balances_integrity_ins;

DROP TRIGGER IF EXISTS account_balances_integrity_upd;

DROP TABLE IF EXISTS schema_meta;

DROP TABLE IF EXISTS seen_webhooks;

DROP TABLE IF EXISTS chain_reproof;
DROP TABLE IF EXISTS archive_state;
DROP TABLE IF EXISTS archive_heads;

DROP TABLE IF EXISTS seal_heads;

DROP TABLE IF EXISTS checkpoints;

DROP TABLE IF EXISTS instance_movements;
DROP TABLE IF EXISTS reservations;

DROP TABLE IF EXISTS trust_attempts;

DROP TABLE IF EXISTS accrual_rows;

DROP TABLE IF EXISTS promo_grants;

DROP TABLE IF EXISTS subscriptions;

DROP TABLE IF EXISTS entitlements;

DROP TABLE IF EXISTS payout_sagas;

DROP TABLE IF EXISTS inbox;

DROP TABLE IF EXISTS outbox;

DROP TABLE IF EXISTS sales;

DROP TABLE IF EXISTS idempotency;

DROP TABLE IF EXISTS account_balances;

DROP TABLE IF EXISTS chain_links;

DROP TABLE IF EXISTS legs;

DROP TABLE IF EXISTS postings;

DROP TABLE IF EXISTS accounts;

-- Rationale in db/postgresql-schema.sql (accounts banner).
CREATE TABLE accounts (
     id         VARCHAR(96)  PRIMARY KEY COMMENT 'Account id; platform:<name> or usr_<uuid>:<kind>.',
     kind       VARCHAR(16)  NOT NULL,
     currency   VARCHAR(8)   NOT NULL,
     created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CHECK (kind IN ('spendable', 'earned', 'promo', 'escrow', 'system')),
     CHECK (currency IN ('CREDIT', 'USD')),
     -- Lets legs carry a composite FK to (id, currency), so a leg's currency must match its account's.
     UNIQUE KEY accounts_id_currency_uq (id, currency)
   ) COMMENT='Every account money posts to: user wallets and the platform accounts.';

INSERT INTO accounts (id, kind, currency) VALUES
     ('platform:trust_cash',     'system', 'USD'),
     ('platform:revenue',        'system', 'CREDIT'),
     ('platform:stored_value',   'system', 'CREDIT'),
     ('platform:payout_reserve', 'system', 'CREDIT'),
     ('platform:receivable',     'system', 'CREDIT'),
     ('platform:promo_float',    'system', 'CREDIT'),
     ('platform:usd_clearing',   'system', 'USD'),
     ('platform:revenue_usd',    'system', 'USD'),
     ('platform:opening_equity', 'system', 'CREDIT'),
     ('platform:netting_clearing','system', 'CREDIT'),
     ('platform:settlement_accrual','system', 'CREDIT');

-- Rationale in db/postgresql-schema.sql (postings banner).
CREATE TABLE postings (
     id         VARCHAR(64) PRIMARY KEY COMMENT 'Transaction id, like txn_<uuid>.',
     meta       JSON        NOT NULL COMMENT 'JSON metadata bag for the posting.',
     posted_at  BIGINT      NOT NULL COMMENT 'Commit time in epoch milliseconds.',
     seq        BIGINT      AUTO_INCREMENT UNIQUE COMMENT 'Auto-increment sequence giving postings a total order.',
     created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) COMMENT='Append-only record of every posting; one balanced set of legs each.';

-- post_entry is the sole writer of this table. Rationale in db/postgresql-schema.sql (legs comment).
CREATE TABLE legs (
     id         BIGINT       AUTO_INCREMENT PRIMARY KEY COMMENT 'Auto-increment leg id in commit order.',
     posting_id VARCHAR(64)  NOT NULL COMMENT 'Parent posting id; FK to postings.',
     account_id VARCHAR(96)  NOT NULL COMMENT 'Account this leg debits or credits.',
     currency   VARCHAR(8)   NOT NULL COMMENT 'Must match the account''s currency.',
     amount     BIGINT       NOT NULL COMMENT 'Signed minor units: debit positive, credit negative; never zero.',
     CHECK (amount <> 0),
     CHECK (currency IN ('CREDIT', 'USD')),
     CONSTRAINT legs_posting_fk FOREIGN KEY (posting_id) REFERENCES postings (id),
     -- Composite FK: a leg's currency must match its account's, enforced natively (not just app-side).
     CONSTRAINT legs_account_fk FOREIGN KEY (account_id, currency) REFERENCES accounts (id, currency),
     -- Serves the maturity tail's keyed newest-first read (legs.id is AUTO_INCREMENT in commit
     -- order) and replaces a bare account_id index. MySQL has no INCLUDE, so currency and amount
     -- ride as trailing key parts to keep the prover's per-account fold index-only.
     KEY legs_account_idx (account_id, id, currency, amount),
     KEY legs_posting_idx (posting_id)
   ) COMMENT='The signed debit/credit lines that make up each posting.';

-- Rationale in db/postgresql-schema.sql (chain_links banner).
CREATE TABLE chain_links (
     posting_id VARCHAR(64) NOT NULL COMMENT 'Posting that advanced this account chain; FK to postings.',
     account_id VARCHAR(96) NOT NULL COMMENT 'Account whose hash chain this link extends; FK to accounts.',
     prev_hash  CHAR(64)    NOT NULL COMMENT 'Previous chain hash, 64 lowercase hex; genesis is zeros.',
     hash       CHAR(64)    NOT NULL COMMENT 'This link''s new chain hash, 64 lowercase hex.',
     -- Rationale in db/postgresql-schema.sql (chain_links.balance_after).
     balance_after BIGINT   NOT NULL DEFAULT 0 COMMENT 'Signed running balance right after this link; cached projection.',
     -- Key of the no-fork unique index below. A digest rather than the raw pair because the raw
     -- pair clusters every new account's first link, and concurrent inserts deadlocked on the
     -- unique check's gap locks. A duplicate pair still produces a duplicate digest, so the guard
     -- is unchanged.
     account_prev_digest BINARY(32)
       GENERATED ALWAYS AS (UNHEX(SHA2(CONCAT(account_id, ':', prev_hash), 256))) STORED
       COMMENT 'SHA-256 of (account_id, prev_hash); key of the no-fork unique index.',
     PRIMARY KEY (posting_id, account_id),
     CONSTRAINT chain_links_posting_fk FOREIGN KEY (posting_id) REFERENCES postings (id),
     CONSTRAINT chain_links_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id),
     -- A previous hash can be used only once per account, so two postings can't both attach at
     -- the same point and fork the chain. The engine recognizes a fork by this index's name in
     -- the 1062 error text (CHAIN_FORK_INDEX, src/engines/sql-shared.ts), so the name is load-bearing.
     UNIQUE KEY chain_links_account_prev_uq (account_prev_digest),
     KEY chain_links_account_idx (account_id),
     -- The continuity trigger reads an account's current head by (account_id, hash).
     KEY chain_links_account_hash_idx (account_id, hash)
   ) COMMENT='Per-account hash-chain links that make the ledger tamper-evident.';

-- Rationale in db/postgresql-schema.sql (account_balances banner).
CREATE TABLE account_balances (
     account_id VARCHAR(96) PRIMARY KEY COMMENT 'Account this cached balance is for; PK and FK to accounts.',
     currency   VARCHAR(8)  NOT NULL COMMENT 'Currency of the balance: CREDIT or USD.',
     balance    BIGINT      NOT NULL DEFAULT 0 COMMENT 'Cached signed balance in minor units; user accounts stay non-negative.',
     -- Chain-head pointer, written with the balance by post_entry. Rationale in
     -- db/postgresql-schema.sql (account_balances.head_hash).
     head_hash  CHAR(64)    NOT NULL
       DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
       COMMENT 'Hash of this account''s latest chain_links row; defaults to genesis zeros.',
     CHECK (currency IN ('CREDIT', 'USD')),
     CHECK (account_id LIKE 'platform:%' OR balance >= 0),
     CONSTRAINT account_balances_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id)
   ) COMMENT='Cached per-account balance read model; re-derivable from the legs.';

-- Rationale in db/postgresql-schema.sql (idempotency banner).
CREATE TABLE idempotency (
     `key`     VARCHAR(255) PRIMARY KEY COMMENT 'Idempotency key; PK that blocks duplicate request execution.',
     -- NULL while a row is claimed but not yet recorded: claim inserts a NULL placeholder to hold
     -- the row lock, then record fills it in.
     transaction JSON        NULL COMMENT 'Recorded result, replayed verbatim on a duplicate request.',
     created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
     -- Oldest-first cutoff scan for the retention sweep (src/worker/retention.ts).
     KEY idempotency_created_idx (created_at)
   ) COMMENT='Exactly-once guard recording each operation outcome by key.';

-- Rationale in db/postgresql-schema.sql (seen_webhooks banner).
CREATE TABLE seen_webhooks (
     event_id   VARCHAR(255) PRIMARY KEY COMMENT 'Provider stable event id; primary key for replay dedup.',
     seen_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC time this event id was first claimed.'
   ) COMMENT='Replay-dedup guard for inbound provider webhooks, by event id.';

-- Rationale in db/postgresql-schema.sql (sales banner).
CREATE TABLE sales (
     order_id     VARCHAR(64) PRIMARY KEY COMMENT 'Order id; primary key, distinct from idempotency key.',
     buyer_id     VARCHAR(64) NOT NULL COMMENT 'Account that paid for the purchase.',
     recipient_id VARCHAR(64) COMMENT 'Account receiving the item; null if buyer.',
     sku          VARCHAR(64) NOT NULL COMMENT 'Catalog item code that was purchased.',
     price        BIGINT      NOT NULL COMMENT 'Purchase price in minor units; always positive.',
     fee          BIGINT      NOT NULL COMMENT 'Platform fee in minor units; zero or more.',
     legs         JSON        NOT NULL COMMENT 'Posted lines as decimal strings for exact replay.',
     txn_id       VARCHAR(64) NOT NULL COMMENT 'Posting transaction id; references postings.id.',
     posted_at    BIGINT      NOT NULL COMMENT 'When the sale posted, epoch ms.',
     CHECK (price > 0),
     CHECK (fee >= 0),
     CONSTRAINT sales_txn_fk FOREIGN KEY (txn_id) REFERENCES postings (id)
   ) COMMENT='Summary of each purchase, keyed by its order id.';

-- Rationale in db/postgresql-schema.sql (outbox banner).
CREATE TABLE outbox (
     id                 VARCHAR(64) PRIMARY KEY COMMENT 'Outbox row id; primary key, obx_<uuid>.',
     event              JSON        NOT NULL COMMENT 'JSON event payload to publish.',
     status             VARCHAR(16) NOT NULL DEFAULT 'pending',
     attempts           INT         NOT NULL DEFAULT 0 COMMENT 'Number of publish attempts so far.',
     dead_letter_reason TEXT        NULL COMMENT 'Last error code if dead; else null.',
     correlation_id     VARCHAR(128) NULL COMMENT 'Id of the request that enqueued this event; null for worker-born events.',
     created_at         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
     CHECK (status IN ('pending', 'relayed', 'dead')),
     KEY outbox_pending_idx (status, created_at)
   ) COMMENT='Pending outbound events awaiting relay to the dispatcher.';

-- Rationale in db/postgresql-schema.sql (inbox banner).
CREATE TABLE inbox (
     id                 VARCHAR(64) PRIMARY KEY COMMENT 'Inbox row id; primary key, ibx_<uuid>.',
     `key`              VARCHAR(255) NOT NULL UNIQUE COMMENT 'Provider event id; unique, dedupes redelivery.',
     operation          JSON         NOT NULL COMMENT 'Serialized Operation to submit, as JSON.',
     status             VARCHAR(16)  NOT NULL DEFAULT 'pending',
     attempts           INT          NOT NULL DEFAULT 0 COMMENT 'Number of apply attempts so far.',
     dead_letter_reason TEXT         NULL COMMENT 'Last error code if dead; else null.',
     received_at        BIGINT       NOT NULL COMMENT 'When the event was enqueued, epoch ms.',
     created_at         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
     CHECK (status IN ('pending', 'applied', 'dead')),
     KEY inbox_pending_idx (status, received_at)
   ) COMMENT='Verified inbound provider events awaiting apply by the worker.';

-- Rationale in db/postgresql-schema.sql (payout_sagas banner).
CREATE TABLE payout_sagas (
     id                 VARCHAR(64) PRIMARY KEY COMMENT 'Saga primary key, pay_ prefixed uuid.',
     user_id            VARCHAR(64) NOT NULL COMMENT 'Seller the payout belongs to.',
     reserve            BIGINT      NOT NULL COMMENT 'Earned credits set aside; always positive.',
     rate_id            VARCHAR(64) NOT NULL COMMENT 'Pinned CREDIT-to-USD rate for this settlement.',
     txn_id             VARCHAR(64) NOT NULL COMMENT 'Reserve posting anchor; every money step re-proves the row against it.',
     state              VARCHAR(16) NOT NULL,
     provider_ref       VARCHAR(128) COMMENT 'Payout provider reference; null until submitted.',
     attempts           INT         NOT NULL DEFAULT 0 COMMENT 'Consecutive worker attempt count.',
     -- Terminal outcome, stored on the saga. Rationale in db/postgresql-schema.sql (payout_sagas).
     reason             VARCHAR(255) COMMENT 'Failure reason set when dead-lettered; null otherwise.',
     payout_usd         BIGINT COMMENT 'USD quote sealed at request; the settle patch re-records the disbursed gross.',
     due_at             BIGINT      NOT NULL COMMENT 'Epoch ms when the worker may next advance it.',
     updated_at         BIGINT      NOT NULL COMMENT 'Epoch ms the row was last updated.',
     CHECK (reserve > 0),
     CHECK (state IN ('REQUESTED', 'RESERVED', 'SUBMITTED', 'SETTLED', 'FAILED')),
     KEY payout_sagas_due_idx (state, due_at),
     -- Serves requestPayout's min-interval gate: MAX(updated_at) for one user across all their sagas.
     KEY payout_sagas_user_updated_idx (user_id, updated_at),
     -- Inbound provider callbacks look up the saga by provider_ref.
     KEY payout_sagas_provider_ref_idx (provider_ref)
   ) COMMENT='Payout state machine: one row per seller cash-out.';

-- Rationale in db/postgresql-schema.sql (accrual_rows banner).
CREATE TABLE accrual_rows (
     order_id    VARCHAR(128) NOT NULL COMMENT 'Order (or charge posting id) the share came from; part of primary key.',
     seller_id   VARCHAR(64)  NOT NULL COMMENT 'Seller the share belongs to; part of primary key.',
     seq         INT          NOT NULL COMMENT '0 for the sale share, higher for refund-recovery rows; part of primary key.',
     amount      BIGINT       NOT NULL COMMENT 'Share in minor units; negative on a refund-recovery row, never zero.',
     shard       VARCHAR(96)  NOT NULL COMMENT 'SETTLEMENT_ACCRUAL shard the spend credited; the drain debits the same row.',
     status      VARCHAR(16)  NOT NULL,
     txn_id      VARCHAR(64)  NOT NULL COMMENT 'Posting that created the row; immutable.',
     settled_txn_id VARCHAR(64) NULL COMMENT 'Drain or refund posting that settled the row; NULL while pending.',
     recorded_at BIGINT       NOT NULL COMMENT 'Epoch ms the row was written.',
     PRIMARY KEY (order_id, seller_id, seq),
     CHECK (status IN ('pending', 'drained', 'refunded')),
     CHECK (amount <> 0),
     KEY accrual_rows_pending_idx (status, seller_id)
   ) COMMENT='Parked seller shares under the accrual split; rows are never deleted.';

-- Rationale in db/postgresql-schema.sql (promo_grants banner).
CREATE TABLE promo_grants (
     id         VARCHAR(64) PRIMARY KEY COMMENT 'Primary key, txn_ uuid shared with the posting.',
     user_id    VARCHAR(64) NOT NULL COMMENT 'User the promotional credit was granted to.',
     amount     BIGINT      NOT NULL COMMENT 'Full original grant in minor units; non-negative.',
     currency   VARCHAR(8)  NOT NULL COMMENT 'CREDIT or USD; always CREDIT in practice.',
     expires_at BIGINT      NOT NULL COMMENT 'Epoch ms the grant expires.',
     reversed   BOOLEAN     NOT NULL DEFAULT FALSE COMMENT 'True once the unspent remainder was reversed.',
     CHECK (amount >= 0),
     CHECK (currency IN ('CREDIT', 'USD')),
     KEY promo_grants_due_idx (reversed, expires_at)
   ) COMMENT='Promotional credit grants with their expiry and reversal state.';

-- Rationale in db/postgresql-schema.sql (entitlements banner).
CREATE TABLE entitlements (
     user_id    VARCHAR(64) NOT NULL COMMENT 'Owner of the entitlement; part of primary key.',
     sku        VARCHAR(64) NOT NULL COMMENT 'SKU the user owns; part of primary key.',
     quantity   INT         NOT NULL DEFAULT 1 COMMENT 'Units owned; non-negative.',
     version    INT         NOT NULL DEFAULT 1 COMMENT 'Optimistic-lock version, bumped on each change.',
     expires_at BIGINT COMMENT 'Epoch ms it lapses; null never lapses.',
     revoked    BOOLEAN     NOT NULL DEFAULT FALSE COMMENT 'True when a refund or clawback removed it.',
     source     VARCHAR(64) COMMENT 'What granted the entitlement; nullable.',
     granted_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC time the entitlement was granted.',
     PRIMARY KEY (user_id, sku),
     CHECK (quantity >= 0)
   ) COMMENT='What each user owns (SKU ownership), with version and expiry.';

-- Rationale in db/postgresql-schema.sql (subscriptions banner).
CREATE TABLE subscriptions (
     id          VARCHAR(64) PRIMARY KEY COMMENT 'Subscription id, sub_<uuid>; primary key.',
     user_id     VARCHAR(64) NOT NULL COMMENT 'Buyer charged each billing period.',
     seller_id   VARCHAR(64) NOT NULL COMMENT 'Seller credited each billing period.',
     sku         VARCHAR(64) NOT NULL COMMENT 'Product identifier being subscribed to.',
     price       BIGINT      NOT NULL COMMENT 'Per-period charge in minor units; always positive.',
     txn_id      VARCHAR(64) NOT NULL COMMENT 'First-charge posting anchor; the renewal sweep re-proves the row against it before every charge.',
     period_ms   BIGINT      NOT NULL COMMENT 'Billing interval length in milliseconds; always positive.',
     state       VARCHAR(16) NOT NULL,
     period      INT         NOT NULL DEFAULT 1 COMMENT 'Billing-cycle counter; renewal bills period plus one.',
     attempts    INT         NOT NULL DEFAULT 0 COMMENT 'Consecutive failed charges; reset to 0 on success.',
     next_due_at BIGINT      NOT NULL COMMENT 'Epoch ms when the next charge is due.',
     updated_at  BIGINT      NOT NULL COMMENT 'Epoch ms of the last update.',
     CHECK (price > 0),
     CHECK (period_ms > 0),
     CHECK (state IN ('ACTIVE', 'LAPSED', 'CANCELED')),
     KEY subscriptions_due_idx (state, next_due_at),
     -- Serves subscribe's duplicate guard: the activeFor lookup by (user_id, sku, seller_id).
     KEY subscriptions_user_sku_seller_idx (user_id, sku, seller_id)
   ) COMMENT='Recurring charges: one row per subscription and its billing state.';

-- Rationale in db/postgresql-schema.sql (trust_attempts banner).
CREATE TABLE trust_attempts (
     idempotency_key VARCHAR(255) PRIMARY KEY COMMENT 'Attempt idempotency key; primary key, dedupes retries.',
     subject         VARCHAR(64)  NOT NULL COMMENT 'Identity whose spend velocity is summed.',
     amount          BIGINT       NOT NULL COMMENT 'Attempted spend in minor units.',
     outcome         VARCHAR(16)  NOT NULL,
     at              BIGINT       NOT NULL COMMENT 'Epoch ms the attempt was recorded.',
     CHECK (outcome IN ('committed', 'rejected')),
     KEY trust_attempts_subject_at_idx (subject, at)
   ) COMMENT='Per-key spend attempts feeding the velocity and risk check.';

-- Rationale in db/postgresql-schema.sql (instance_movements banner).
CREATE TABLE instance_movements (
     id          BIGINT       AUTO_INCREMENT PRIMARY KEY COMMENT 'Auto-increment row id in commit order.',
     session_id  VARCHAR(64)  NOT NULL COMMENT 'Instance session this movement belongs to.',
     seq         INT          NOT NULL COMMENT 'Position in the session chain, from 0.',
     idem_key    VARCHAR(128) NOT NULL COMMENT 'Movement idempotency key; unique across all sessions.',
     legs        JSON         NOT NULL COMMENT 'The balanced legs, amounts as encoded strings.',
     prev_hash   CHAR(64)     NOT NULL COMMENT 'Session chain hash before this movement; genesis is zeros.',
     hash        CHAR(64)     NOT NULL COMMENT 'Session chain hash after this movement.',
     recorded_at BIGINT       NOT NULL COMMENT 'Epoch ms the movement was accepted.',
     UNIQUE KEY instance_movements_idem_uq (idem_key),
     -- One row per (session, position): settle replays the chain in seq order, and this unique key
     -- makes a forked or double-appended position impossible to store.
     UNIQUE KEY instance_movements_session_seq_uq (session_id, seq)
   ) COMMENT='Append-only instance-netting journal; the settlement posting anchors its chain head.';

-- Rationale in db/postgresql-schema.sql (reservations banner).
CREATE TABLE reservations (
     account_id VARCHAR(96) PRIMARY KEY COMMENT 'Account whose cross-node pending total this row holds.',
     pending    BIGINT      NOT NULL COMMENT 'Natural pending total across every node; advisory, never money.'
   ) COMMENT='Multi-node reservation counter behind sharedReservations; stale-high totals only refuse movements.';

-- Rationale in db/postgresql-schema.sql (seal_heads banner).
CREATE TABLE seal_heads (
     account_id VARCHAR(96) PRIMARY KEY COMMENT 'Account the sealed leaf belongs to.',
     head       CHAR(64)    NOT NULL COMMENT 'Chain-head hash at the latest seal; lowercase hex.',
     sum        BIGINT      NOT NULL COMMENT 'Raw signed leg sum at the latest seal (debit positive).'
   ) COMMENT='The latest checkpoint\'s Merkle leaves, one row per account; authenticated against the signed root before the incremental seal trusts it.';

-- Rationale in db/postgresql-schema.sql (chain_reproof banner).
CREATE TABLE chain_reproof (
     cursor_seq BIGINT NULL COMMENT 'Where the rolling re-proof walk stands; NULL between rotations.',
     rotated_at BIGINT NULL COMMENT 'Epoch ms the last complete rotation finished; the verified-through watermark.'
   ) COMMENT='Rolling re-proof cursor and last-rotation watermark; single row.';

-- Rationale in db/postgresql-schema.sql (archival boundary banner).
CREATE TABLE archive_state (
     through_seq   BIGINT       NOT NULL COMMENT 'Postings with seq at or below this are archived.',
     cursor_seq    BIGINT       NULL COMMENT 'Mid-run resume point; NULL between runs.',
     root          CHAR(64)     NOT NULL COMMENT 'Merkle sum-root over archive_heads; lowercase hex.',
     signature     VARCHAR(144) NOT NULL COMMENT 'Domain-tagged signature over the root and sum.',
     checkpoint_id VARCHAR(64)  NOT NULL COMMENT 'The sealed checkpoint this archival ran under.',
     at            BIGINT       NOT NULL COMMENT 'Epoch ms the last page moved.'
   ) COMMENT='Signed archival watermark; single row, verified before any prover anchors on it.';

CREATE TABLE archive_heads (
     account_id VARCHAR(96) PRIMARY KEY COMMENT 'Account whose archival boundary this row holds.',
     head       CHAR(64)    NOT NULL COMMENT 'Hash of the last archived chain link; lowercase hex.',
     sum        BIGINT      NOT NULL COMMENT 'Raw signed leg sum of the archived prefix (debit positive).'
   ) COMMENT='Per-account archival boundary, sealed under archive_state root+signature.';

-- Rationale in db/postgresql-schema.sql (checkpoints banner).
CREATE TABLE checkpoints (
     id         VARCHAR(64) PRIMARY KEY COMMENT 'Checkpoint id, chk_<uuid>; primary key.',
     root       CHAR(64)    NOT NULL COMMENT 'Merkle root over account hashes (v2: hashes and sums); lowercase hex.',
     signature  TEXT        NOT NULL COMMENT 'Signature (v1: over the root; v2: over root and sum); lowercase hex.',
     count      BIGINT      NOT NULL COMMENT 'How many account hashes this root covers.',
     at         BIGINT      NOT NULL COMMENT 'Epoch ms the checkpoint was taken.',
     v          TINYINT     NOT NULL DEFAULT 1 COMMENT 'Preimage construction the row was sealed under; pre-versioning rows are 1.',
     sum        VARCHAR(32) NULL COMMENT 'Signed decimal minor-unit sum under a v2 root (zero when honestly sealed); null on v1 rows.',
     kid        VARCHAR(64) NULL COMMENT 'Id of the signing key that sealed the row; null before kid stamping.',
     seq        BIGINT      AUTO_INCREMENT UNIQUE COMMENT 'Monotonic sequence number; unique, auto-assigned.',
     created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) COMMENT='Signed Merkle checkpoints over the per-account hash chains.';

-- ============================================================================
-- Stored routines (MySQL), counterpart to the Postgres routines in db/postgresql-schema.sql. The
-- database, not the app, is the primary enforcer: post_entry asserts conservation and is the SOLE
-- writer of `legs` (direct DML revoked from the app role), the triggers below enforce chain
-- continuity and balance integrity, CHECKs cover no-overdraft, primary keys cover exactly-once.
-- Wrapped in `DELIMITER $$` so the loader doesn't read the bodies' semicolons as ends.
--
-- NOTE: with binary logging enabled, creating a stored FUNCTION can require a one-time
-- `SET GLOBAL log_bin_trust_function_creators = 1` (or SUPER / SYSTEM_VARIABLES_ADMIN). The
-- PROCEDURE has no such requirement.
-- ============================================================================

-- ============================================================================
-- Least-privilege app role (a deploy requirement — this file does not run it). MySQL has no
-- deferred constraint trigger, so post_entry's conservation check only binds if nothing else can
-- INSERT into `legs`: the app must connect as a role that can CALL the procedure but not write
-- `legs` directly.
--
--   CREATE ROLE economy_app
--   GRANT SELECT, EXECUTE        ON `economy_lab`.*       TO economy_app   -- read all + CALL post_entry
--   GRANT INSERT, UPDATE, DELETE ON `economy_lab`.<table> TO economy_app   -- every ledger table EXCEPT `legs`
--   GRANT economy_app TO '<app_login>'@'<host>'
--
-- DML stays granted elsewhere on purpose: continuity, balance integrity, overdraft, and
-- exactly-once must each be reachable by a raw write so their triggers, CHECKs, and keys do the
-- rejecting. Only `legs` is sealed. post_entry runs as DEFINER, so invoked by economy_app it
-- still writes `legs` with the owner's rights — the DEFINER must keep `legs` DML and be a
-- different identity from economy_app. test/conformance/adversarial-engines.ts builds this role
-- and proves a raw unbalanced-leg INSERT is refused while balanced legs still post.
-- ============================================================================
DELIMITER $$

-- Persists one posting and everything derived from it in a single CALL. Counterpart to the
-- Postgres post_entry (db/postgresql-schema.sql), which carries the rationale.
CREATE PROCEDURE post_entry(
  IN p_txn          VARCHAR(64),
  IN p_posted_at    BIGINT,
  IN p_meta         JSON,
  IN p_legs         JSON,   -- [{account, currency, amount}]   raw signed: debit +, credit -
  IN p_links        JSON,   -- [{account, prev_hash, hash}]    one per distinct account
  IN p_balances     JSON,   -- [{account, currency, delta}]    per-account net balanceDelta
  IN p_new_accounts JSON    -- [{id, kind, currency}]          user accounts created on first use
)
BEGIN
  INSERT IGNORE INTO accounts (id, kind, currency)
    SELECT a.id, a.kind, a.currency
      FROM JSON_TABLE(p_new_accounts, '$[*]' COLUMNS (
        id       VARCHAR(96) PATH '$.id',
        kind     VARCHAR(16) PATH '$.kind',
        currency VARCHAR(8)  PATH '$.currency'
      )) AS a;

  INSERT INTO postings (id, meta, posted_at) VALUES (p_txn, p_meta, p_posted_at);

  INSERT INTO legs (posting_id, account_id, currency, amount)
    SELECT p_txn, l.account, l.currency, CAST(l.amount AS SIGNED)
      FROM JSON_TABLE(p_legs, '$[*]' COLUMNS (
        account  VARCHAR(96) PATH '$.account',
        currency VARCHAR(8)  PATH '$.currency',
        amount   VARCHAR(32) PATH '$.amount'
      )) AS l;

  -- Conservation check (MySQL). With direct DML on `legs` revoked, post_entry is the only writer, so
  -- this assert is the sole route by which legs not netting to zero per currency are refused -- the
  -- content half of the Postgres deferred trigger. Legitimate postings always balance (assertBalanced,
  -- src/ledger.ts), so this fires only on malformed input.
  IF EXISTS (
    SELECT 1 FROM legs WHERE posting_id = p_txn GROUP BY currency HAVING SUM(amount) <> 0
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conservation: posting legs do not net to zero per currency';
  END IF;

  -- One link per distinct account, carrying its signed running balance after this posting (current
  -- cached balance, 0 if none yet, plus the net delta). account_balances still holds the OLD balance
  -- here (the balance step runs after), so by construction this equals what that step writes, which
  -- balance integrity later compares at the account's head.
  INSERT INTO chain_links (posting_id, account_id, prev_hash, hash, balance_after)
    SELECT p_txn, c.account, c.prev_hash, c.hash,
           COALESCE(ab.balance, 0) + CAST(d.delta AS SIGNED)
      FROM JSON_TABLE(p_links, '$[*]' COLUMNS (
        account   VARCHAR(96) PATH '$.account',
        prev_hash VARCHAR(64) PATH '$.prev_hash',
        hash      VARCHAR(64) PATH '$.hash'
      )) AS c
      JOIN JSON_TABLE(p_balances, '$[*]' COLUMNS (
        account VARCHAR(96) PATH '$.account',
        delta   VARCHAR(32) PATH '$.delta'
      )) AS d ON d.account = c.account
      LEFT JOIN account_balances ab ON ab.account_id = c.account;

  -- p_links carries one row per distinct account (the same set as p_balances), so the join pairs
  -- each balance row with its new head. UPDATE existing rows first so the non-negative CHECK
  -- tests the new total, not the delta alone.
  UPDATE account_balances ab
    JOIN JSON_TABLE(p_balances, '$[*]' COLUMNS (
      account VARCHAR(96) PATH '$.account',
      delta   VARCHAR(32) PATH '$.delta'
    )) AS d ON ab.account_id = d.account
    JOIN JSON_TABLE(p_links, '$[*]' COLUMNS (
      account VARCHAR(96) PATH '$.account',
      hash    VARCHAR(64) PATH '$.hash'
    )) AS c ON c.account = d.account
    SET ab.balance = ab.balance + CAST(d.delta AS SIGNED),
        ab.head_hash = c.hash;

  INSERT INTO account_balances (account_id, currency, balance, head_hash)
    SELECT d.account, d.currency, CAST(d.delta AS SIGNED), c.hash
      FROM JSON_TABLE(p_balances, '$[*]' COLUMNS (
        account  VARCHAR(96) PATH '$.account',
        currency VARCHAR(8)  PATH '$.currency',
        delta    VARCHAR(32) PATH '$.delta'
      )) AS d
      JOIN JSON_TABLE(p_links, '$[*]' COLUMNS (
        account VARCHAR(96) PATH '$.account',
        hash    VARCHAR(64) PATH '$.hash'
      )) AS c ON c.account = d.account
     WHERE NOT EXISTS (
       SELECT 1 FROM account_balances ab WHERE ab.account_id = d.account
     )
    ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance),
                            head_hash = VALUES(head_hash);
END$$

-- TrustStore.record's atomic record-then-measure in one round trip: the subject-scoped named
-- lock serializes same-subject callers until the caller's transaction releases it, the insert
-- dedupes on the attempt key, and the window read runs after the insert so the returned velocity
-- already includes this attempt. The proc derives the lock name itself: the trust: tag keeps a
-- subject lock from colliding with an account lock, capped like lockName in src/engines/mysql.ts.
-- A non-acquire signals errno 1205 so the transient retry classifies it like any lock wait,
-- matching the client-side GET_LOCK path this replaces.
CREATE PROCEDURE trust_record(
  IN p_key     VARCHAR(255),
  IN p_subject VARCHAR(64),
  IN p_amount  BIGINT,
  IN p_outcome VARCHAR(16),
  IN p_at      BIGINT,
  IN p_cutoff  BIGINT
)
BEGIN
  DECLARE v_name VARCHAR(80) DEFAULT CONCAT('trust:', p_subject);
  IF CHAR_LENGTH(v_name) > 56 THEN
    SET v_name = CONCAT(LEFT(v_name, 48), '#', CHAR_LENGTH(v_name));
  END IF;
  -- COALESCE: GET_LOCK returns NULL on error or kill, which must fail the acquire, not skip it.
  IF COALESCE((SELECT GET_LOCK(v_name, 10)), 0) <> 1 THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 1205, MESSAGE_TEXT = 'trust_record: GET_LOCK did not acquire';
  END IF;
  INSERT IGNORE INTO trust_attempts (idempotency_key, subject, amount, outcome, at)
    VALUES (p_key, p_subject, p_amount, p_outcome, p_at);
  SELECT COALESCE(MIN(at), 0) AS window_start,
         COALESCE(SUM(amount), 0) AS spent,
         COUNT(*) AS attempts
    FROM trust_attempts
   WHERE subject = p_subject AND at > p_cutoff;
END$$

-- Returns one account's cached balance, 0 when it has no row yet.
CREATE FUNCTION account_balance(p_account VARCHAR(96))
RETURNS BIGINT
READS SQL DATA
BEGIN
  DECLARE v_balance BIGINT;
  SELECT balance INTO v_balance FROM account_balances WHERE account_id = p_account;
  RETURN COALESCE(v_balance, 0);
END$$

-- Chain continuity: a new link's prev_hash must be the account's current head (GENESIS for the
-- first link). Blocks a discontinuous link written around post_entry. The unique index already
-- blocks a fork.
CREATE TRIGGER chain_links_continuity BEFORE INSERT ON chain_links
FOR EACH ROW
BEGIN
  IF NEW.prev_hash = REPEAT('0', 64) THEN
    IF EXISTS (SELECT 1 FROM chain_links WHERE account_id = NEW.account_id) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'chain continuity: genesis link on a non-empty chain';
    END IF;
  ELSEIF NOT EXISTS (SELECT 1 FROM chain_links WHERE account_id = NEW.account_id AND hash = NEW.prev_hash) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'chain continuity: prev_hash is not the current head';
  END IF;
END$$

-- Balance integrity: cached balance must equal balance_after at the account's head. Rationale in
-- db/postgresql-schema.sql (balance integrity banner).
CREATE TRIGGER account_balances_integrity_ins BEFORE INSERT ON account_balances
FOR EACH ROW
BEGIN
  DECLARE expected BIGINT;
  SET expected = COALESCE(
    (SELECT balance_after FROM chain_links
      WHERE account_id = NEW.account_id AND hash = NEW.head_hash),
    0
  );
  IF NEW.balance <> expected THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'balance integrity: cached balance <> chain head balance';
  END IF;
END$$

-- The fused variant: several postings in one round trip, looped server-side through post_entry
-- so the semantics are byte-identical to calling it per posting — a later element sees the
-- balances and heads an earlier one wrote. Rationale in db/postgresql-schema.sql (post_entries).
CREATE PROCEDURE post_entries(IN p_entries JSON)
BEGIN
  DECLARE i INT DEFAULT 0;
  DECLARE n INT DEFAULT JSON_LENGTH(p_entries);
  WHILE i < n DO
    CALL post_entry(
      JSON_UNQUOTE(JSON_EXTRACT(p_entries, CONCAT('$[', i, '].txn'))),
      CAST(JSON_UNQUOTE(JSON_EXTRACT(p_entries, CONCAT('$[', i, '].postedAt'))) AS UNSIGNED),
      JSON_EXTRACT(p_entries, CONCAT('$[', i, '].meta')),
      JSON_EXTRACT(p_entries, CONCAT('$[', i, '].legs')),
      JSON_EXTRACT(p_entries, CONCAT('$[', i, '].links')),
      JSON_EXTRACT(p_entries, CONCAT('$[', i, '].balances')),
      JSON_EXTRACT(p_entries, CONCAT('$[', i, '].newAccounts'))
    );
    SET i = i + 1;
  END WHILE;
END$$

CREATE TRIGGER account_balances_integrity_upd BEFORE UPDATE ON account_balances
FOR EACH ROW
BEGIN
  DECLARE expected BIGINT;
  SET expected = COALESCE(
    (SELECT balance_after FROM chain_links
      WHERE account_id = NEW.account_id AND hash = NEW.head_hash),
    0
  );
  IF NEW.balance <> expected THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'balance integrity: cached balance <> chain head balance';
  END IF;
END$$

DELIMITER ;

-- Pre-plant an empty balance row for each system account so lockAccounts can take `FOR UPDATE`
-- on it (full rationale in db/postgresql-schema.sql, at its seed). Placed after the routines,
-- unlike the Postgres seed, so the integrity triggers exist and pass on these genesis rows.
INSERT INTO account_balances (account_id, currency, balance, head_hash)
  SELECT id, currency, 0, REPEAT('0', 64) FROM accounts WHERE kind = 'system';

-- Schema version stamp. The engine reads this on startup and refuses to run if it does not match
-- SCHEMA_VERSION in src/schema.ts. Keep the value in lockstep with the Postgres schema and src/schema.ts.
CREATE TABLE schema_meta (
     version VARCHAR(32) NOT NULL COMMENT 'Schema version stamp; must match SCHEMA_VERSION at startup.'
   ) COMMENT='Single-row schema version stamp, checked at startup.';
-- = SCHEMA_VERSION (src/schema.ts) and the Postgres stamp. No trailing comment on the INSERT
-- line: the statement splitter reads line ends for the delimiter.
INSERT INTO schema_meta (version) VALUES ('17');
