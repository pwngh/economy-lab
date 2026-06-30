-- @pwngh/economy-lab
--
-- Copyright (c) Preston Neal
--
-- This source code is licensed under the MIT license found in the
-- LICENSE.md file in the root directory of this source tree.
--
-- @license MIT

-- MySQL counterpart to db/postgresql-schema.sql. Applied by `applyMysqlSchema`
-- (src/engines/mysql.ts) via a DELIMITER-aware splitter that runs one statement
-- at a time (mysql2 sends one per query). Drops everything up front, so re-running
-- resets. Stored routines use `DELIMITER $$` as the mysql CLI does; the loader
-- handles that directive.
--
-- MySQL has no partial index, so each Postgres partial-index predicate folds into the leading column
-- of the composite key here. The *_pending_idx and *_due_idx indexes lead with the status, state, or
-- reversed column the Postgres `WHERE` filtered on. That keeps the sweep and relay scans narrow.

-- Pin the database default collation FIRST, so every table below inherits it (none declare their
-- own). The strings JSON_TABLE produces inside post_entry are utf8mb4_0900_ai_ci. Matching the tables
-- to that collation avoids an "Illegal mix of collations" error on the `ab.account_id = d.account`
-- joins. Both `applyMysqlSchema` and `mysql < db/mysql-schema.sql` (scripts/migrate.sh) apply it this
-- way.
ALTER DATABASE CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Drop stored routines first: unlike DROP TABLE they have no IF-EXISTS-on-CREATE form, so re-apply
-- fails with ER_SP_ALREADY_EXISTS without an explicit drop. (CREATE TABLE below is guarded by the
-- DROP TABLEs.)
DROP PROCEDURE IF EXISTS post_entry;

DROP FUNCTION IF EXISTS account_balance;

DROP TRIGGER IF EXISTS chain_links_continuity;

DROP TRIGGER IF EXISTS account_balances_integrity_ins;

DROP TRIGGER IF EXISTS account_balances_integrity_upd;

DROP TABLE IF EXISTS schema_meta;
DROP TABLE IF EXISTS seen_webhooks;

DROP TABLE IF EXISTS checkpoints;

DROP TABLE IF EXISTS trust_attempts;

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

CREATE TABLE accounts (
     id         VARCHAR(96)  PRIMARY KEY,
     kind       VARCHAR(16)  NOT NULL,
     currency   VARCHAR(8)   NOT NULL,
     created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CHECK (kind IN ('spendable', 'earned', 'promo', 'system')),
     CHECK (currency IN ('CREDIT', 'USD')),
     -- Lets legs carry a composite FK to (id, currency), so a leg's currency must match its account's.
     UNIQUE KEY accounts_id_currency_uq (id, currency)
   );

INSERT INTO accounts (id, kind, currency) VALUES
     ('platform:trust_cash',     'system', 'USD'),
     ('platform:revenue',        'system', 'CREDIT'),
     ('platform:stored_value',   'system', 'CREDIT'),
     ('platform:payout_reserve', 'system', 'CREDIT'),
     ('platform:receivable',     'system', 'CREDIT'),
     ('platform:promo_float',    'system', 'CREDIT'),
     ('platform:usd_clearing',   'system', 'USD'),
     ('platform:revenue_usd',    'system', 'USD'),
     ('platform:opening_equity', 'system', 'CREDIT');

CREATE TABLE postings (
     id         VARCHAR(64) PRIMARY KEY,
     meta       JSON        NOT NULL,
     posted_at  BIGINT      NOT NULL,
     seq        BIGINT      AUTO_INCREMENT UNIQUE,
     created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
   );

CREATE TABLE legs (
     id         BIGINT       AUTO_INCREMENT PRIMARY KEY,
     posting_id VARCHAR(64)  NOT NULL,
     account_id VARCHAR(96)  NOT NULL,
     currency   VARCHAR(8)   NOT NULL,
     amount     BIGINT       NOT NULL,
     CHECK (amount <> 0),
     CHECK (currency IN ('CREDIT', 'USD')),
     CONSTRAINT legs_posting_fk FOREIGN KEY (posting_id) REFERENCES postings (id),
     -- Composite FK: a leg's currency must match its account's, enforced natively (not just app-side).
     CONSTRAINT legs_account_fk FOREIGN KEY (account_id, currency) REFERENCES accounts (id, currency),
     -- Composite index on (account_id, id). The maturity tail reads an account's newest lots with
     -- `WHERE account_id = ? ORDER BY id DESC LIMIT n` (src/engines, timelineOf). legs.id is an
     -- AUTO_INCREMENT assigned in commit order, so ordering by it gives the FIFO order the tail
     -- walks, and this index serves that query as a bounded keyed scan with no filesort over the
     -- account's whole leg history. The leading account_id column also covers the plain account_id
     -- lookups (statement, lineage), so this replaces a bare legs(account_id) index. Mirrors the
     -- Postgres legs_account_idx. (legs.id is the PK, so naming it in the index needs no extra column.)
     KEY legs_account_idx (account_id, id),
     KEY legs_posting_idx (posting_id)
   );

CREATE TABLE chain_links (
     posting_id VARCHAR(64) NOT NULL,
     account_id VARCHAR(96) NOT NULL,
     prev_hash  CHAR(64)    NOT NULL,
     hash       CHAR(64)    NOT NULL,
     -- Holds the account's signed running balance immediately after this link. It is the same figure
     -- post_entry writes into account_balances.balance for this account in the same CALL. Storing it
     -- lets balance integrity compare a cached balance to its chain head in O(1), instead of re-summing
     -- the whole leg history on every balance write. This is a maintained projection of the legs, not
     -- the source of truth, so prove() still re-sums. It defaults to 0 so a link written around
     -- post_entry carries the genesis balance. Rationale documented in db/postgresql-schema.sql
     -- (chain_links.balance_after).
     balance_after BIGINT   NOT NULL DEFAULT 0,
     PRIMARY KEY (posting_id, account_id),
     CONSTRAINT chain_links_posting_fk FOREIGN KEY (posting_id) REFERENCES postings (id),
     CONSTRAINT chain_links_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id),
     UNIQUE KEY chain_links_account_prev_uq (account_id, prev_hash),
     KEY chain_links_account_idx (account_id),
     -- The continuity trigger's non-genesis branch looks up an account's current head by
     -- (account_id, hash); without this it scans every link for the account, so the trigger's
     -- cost grows with that account's chain length on each new posting.
     KEY chain_links_account_hash_idx (account_id, hash)
   );

-- account_balances: cached per-account balance read model. Rationale/invariants (non-negative
-- overdraft guard, always re-derivable from legs) documented in db/postgresql-schema.sql.
CREATE TABLE account_balances (
     account_id VARCHAR(96) PRIMARY KEY,
     currency   VARCHAR(8)  NOT NULL,
     balance    BIGINT      NOT NULL DEFAULT 0,
     -- Points at the chain head: the hash of this account's latest chain_links row, updated in the
     -- same transaction as the balance (post_entry writes both). It is a maintained projection
     -- alongside `balance`, under the same trust model. chain_links stays the source of truth, so
     -- prove() still re-walks it. Storing it lets headsForAccounts read each account's head by primary
     -- key, instead of scanning chain_links and sorting. Defaults to the genesis hash (64 zeros).
     head_hash  CHAR(64)    NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
     CHECK (currency IN ('CREDIT', 'USD')),
     CHECK (account_id LIKE 'platform:%' OR balance >= 0),
     CONSTRAINT account_balances_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id)
   );

-- idempotency: exactly-once retry guard. Rationale/invariants documented in
-- db/postgresql-schema.sql (idempotency banner).
CREATE TABLE idempotency (
     `key`     VARCHAR(255) PRIMARY KEY,
     transaction JSON        NULL,  -- The recorded result, replayed verbatim on a duplicate. It is NULL while a row is claimed but not yet recorded. Claim inserts a NULL placeholder to hold the row lock, then record fills it in.
     created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
   );

CREATE TABLE sales (
     order_id     VARCHAR(64) PRIMARY KEY,
     buyer_id     VARCHAR(64) NOT NULL,
     recipient_id VARCHAR(64),
     sku          VARCHAR(64) NOT NULL,
     price        BIGINT      NOT NULL,
     fee          BIGINT      NOT NULL,
     legs         JSON        NOT NULL,
     txn_id       VARCHAR(64) NOT NULL,
     posted_at    BIGINT      NOT NULL,
     CHECK (price > 0),
     CHECK (fee >= 0),
     CONSTRAINT sales_txn_fk FOREIGN KEY (txn_id) REFERENCES postings (id)
   );

-- outbox: events awaiting publish via the transactional outbox relay. Rationale/invariants
-- documented in db/postgresql-schema.sql (outbox banner).
CREATE TABLE outbox (
     id                 VARCHAR(64) PRIMARY KEY,
     event              JSON        NOT NULL,
     status             VARCHAR(16) NOT NULL DEFAULT 'pending',
     attempts           INT         NOT NULL DEFAULT 0,
     dead_letter_reason TEXT        NULL,
     created_at         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
     CHECK (status IN ('pending', 'relayed', 'failed')),
     KEY outbox_pending_idx (status, created_at)
   );

-- inbox: the inbound mirror of `outbox`; verified provider events awaiting apply via the
-- transactional inbox worker. `key` is the provider event id (UNIQUE -> redelivery is a no-op
-- insert, applied at most once). Rationale/invariants documented in db/postgresql-schema.sql
-- (inbox banner).
CREATE TABLE inbox (
     id                 VARCHAR(64) PRIMARY KEY,
     `key`              VARCHAR(255) NOT NULL UNIQUE,
     operation          JSON         NOT NULL,
     status             VARCHAR(16)  NOT NULL DEFAULT 'pending',
     attempts           INT          NOT NULL DEFAULT 0,
     dead_letter_reason TEXT         NULL,
     received_at        BIGINT       NOT NULL,
     created_at         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
     CHECK (status IN ('pending', 'applied', 'dead')),
     KEY inbox_pending_idx (status, received_at)
   );

-- payout_sagas: multi-step payout saga state. Rationale/invariants documented in
-- db/postgresql-schema.sql (payout_sagas banner).
CREATE TABLE payout_sagas (
     id                 VARCHAR(64) PRIMARY KEY,
     user_id            VARCHAR(64) NOT NULL,
     reserve            BIGINT      NOT NULL,
     rate_id            VARCHAR(64) NOT NULL,
     state              VARCHAR(16) NOT NULL,
     provider_ref       VARCHAR(128),
     attempts           INT         NOT NULL DEFAULT 0,
     due_at             BIGINT      NOT NULL,
     updated_at         BIGINT      NOT NULL,
     -- The payout's terminal outcome, stored on the saga (see db/postgresql-schema.sql). `reason` is
     -- the worker's failure reason (FAILED); `payout_usd` is the gross USD disbursed (SETTLED). Both
     -- null until the saga reaches its terminal state.
     reason             VARCHAR(255),
     payout_usd         BIGINT,
     CHECK (reserve > 0),
     CHECK (state IN ('REQUESTED', 'RESERVED', 'SUBMITTED', 'SETTLED', 'FAILED')),
     KEY payout_sagas_due_idx (state, due_at),
     -- requestPayout's min-interval gate reads MAX(updated_at) for one user across all their sagas,
     -- without this it scans every saga that user has ever had, so the check's cost grows with their
     -- payout history on each new request.
     KEY payout_sagas_user_updated_idx (user_id, updated_at)
   );

-- promo_grants: one row per promotional credit handed out; swept for expired, not-yet-reversed
-- grants. Rationale/invariants documented in db/postgresql-schema.sql (promo_grants banner).
CREATE TABLE promo_grants (
     id         VARCHAR(64) PRIMARY KEY,
     user_id    VARCHAR(64) NOT NULL,
     amount     BIGINT      NOT NULL,
     currency   VARCHAR(8)  NOT NULL,
     expires_at BIGINT      NOT NULL,
     reversed   BOOLEAN     NOT NULL DEFAULT FALSE,
     CHECK (amount >= 0),
     CHECK (currency IN ('CREDIT', 'USD')),
     KEY promo_grants_due_idx (reversed, expires_at)
   );

CREATE TABLE entitlements (
     user_id    VARCHAR(64) NOT NULL,
     sku        VARCHAR(64) NOT NULL,
     quantity   INT         NOT NULL DEFAULT 1,
     version    INT         NOT NULL DEFAULT 1,
     expires_at BIGINT,
     revoked    BOOLEAN     NOT NULL DEFAULT FALSE,
     source     VARCHAR(64),
     granted_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (user_id, sku),
     CHECK (quantity >= 0)
   );

-- subscriptions: recurring-charge state read by the renewal sweep. Rationale/invariants
-- documented in db/postgresql-schema.sql (subscriptions banner).
CREATE TABLE subscriptions (
     id          VARCHAR(64) PRIMARY KEY,
     user_id     VARCHAR(64) NOT NULL,
     seller_id   VARCHAR(64) NOT NULL,
     sku         VARCHAR(64) NOT NULL,
     price       BIGINT      NOT NULL,
     period_ms   BIGINT      NOT NULL,
     state       VARCHAR(16) NOT NULL,
     period      INT         NOT NULL DEFAULT 1,
     attempts    INT         NOT NULL DEFAULT 0,
     next_due_at BIGINT      NOT NULL,
     updated_at  BIGINT      NOT NULL,
     CHECK (price > 0),
     CHECK (period_ms > 0),
     CHECK (state IN ('ACTIVE', 'LAPSED', 'CANCELED')),
     KEY subscriptions_due_idx (state, next_due_at),
     -- subscribe's activeFor lookup filters by (user_id, sku, seller_id) to find the one ACTIVE row,
     -- without this it scans every subscription a user holds, so the duplicate-guard's cost grows with
     -- their subscription count on each new subscribe.
     KEY subscriptions_user_sku_seller_idx (user_id, sku, seller_id)
   );

CREATE TABLE trust_attempts (
     idempotency_key VARCHAR(255) PRIMARY KEY,
     subject         VARCHAR(64)  NOT NULL,
     amount          BIGINT       NOT NULL,
     outcome         VARCHAR(16)  NOT NULL,
     at              BIGINT       NOT NULL,
     CHECK (outcome IN ('committed', 'rejected')),
     KEY trust_attempts_subject_at_idx (subject, at)
   );

-- checkpoints: signed Merkle-root snapshots of ledger state. Rationale/invariants documented in
-- db/postgresql-schema.sql (checkpoints banner).
CREATE TABLE checkpoints (
     id         VARCHAR(64) PRIMARY KEY,
     root       CHAR(64)    NOT NULL,
     signature  TEXT        NOT NULL,
     count      BIGINT      NOT NULL,
     at         BIGINT      NOT NULL,
     seq        BIGINT      AUTO_INCREMENT UNIQUE,
     created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
   );

-- seen_webhooks: exactly-once replay dedup for inbound provider callbacks, claimed as the last
-- gate (after HMAC and freshness). Only PK presence is used, so a duplicate delivery finds the row
-- and does no work. Rationale/invariants documented in db/postgresql-schema.sql (seen_webhooks
-- banner). The metadata column name differs cosmetically (created_at here vs seen_at in PG).
CREATE TABLE seen_webhooks (
     event_id   VARCHAR(255) PRIMARY KEY,
     created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
   );

-- ============================================================================
-- Stored routines (MySQL) plus the engine's invariant enforcement. Counterpart to the Postgres
-- routines in db/postgresql-schema.sql. The application computes the values and passes them in; the
-- routines write the rows. Here the database, not the application, is the primary enforcer of the
-- ledger invariants, not just a safety net. post_entry asserts conservation and is the SOLE writer of
-- `legs` (direct DML is revoked from the app role; see adversarial-engines.ts). The triggers below
-- enforce chain continuity and balance integrity. The CHECK constraints above cover no-overdraft, and
-- the primary keys cover exactly-once. The routines are wrapped in `DELIMITER $$` so the loader (and
-- the mysql CLI) don't read the semicolons inside each body as statement ends.
--
-- NOTE: with binary logging enabled, creating a stored FUNCTION can require a one-time
-- `SET GLOBAL log_bin_trust_function_creators = 1` (or SUPER / SYSTEM_VARIABLES_ADMIN). The
-- PROCEDURE has no such requirement.
-- ============================================================================

-- ============================================================================
-- Least-privilege app role (a deploy requirement; this file does not run it).
-- post_entry's claim to be the SOLE writer of `legs` is, on MySQL, a privilege fact rather than a
-- constraint. Postgres rejects an unbalanced leg written around the procedure with the deferred
-- legs_conserve trigger (it checks at COMMIT); MySQL has no deferred constraint triggers, so the
-- conservation check lives inside post_entry and only binds if nothing else can INSERT into `legs`.
-- The application must therefore connect as a role that can CALL the procedure but cannot write
-- `legs` directly:
--
--   CREATE ROLE economy_app;
--   GRANT SELECT, EXECUTE        ON `economy_lab`.*       TO economy_app;  -- read all + CALL post_entry
--   GRANT INSERT, UPDATE, DELETE ON `economy_lab`.<table> TO economy_app;  -- every ledger table EXCEPT `legs`
--   GRANT economy_app TO '<app_login>'@'<host>';                          -- then have the app connect as <app_login>
--
-- DML stays granted on every other table on purpose. Chain continuity, balance integrity, overdraft,
-- and exactly-once must each be reachable by a raw write, so their own triggers, CHECKs, and keys do
-- the rejecting. Only `legs` is sealed. post_entry declares no SQL SECURITY clause, so it runs as
-- DEFINER. Invoked by economy_app, it still writes `legs` with the schema owner's rights, balanced by
-- construction. That assumes the DEFINER (whoever applies this file) keeps `legs` DML and is a
-- different identity from economy_app.
--
-- Not executed here: the schema is applied by one privileged connection (scripts/migrate.sh), the
-- database name isn't known statically, and provisioning a second login is a deployment rail this lab
-- stubs. test/conformance/adversarial-engines.ts builds exactly this role and proves a raw
-- unbalanced-leg INSERT is refused while balanced legs still post through post_entry.
-- ============================================================================
DELIMITER $$

-- Persists one posting and everything derived from it in a single CALL. It ensures any first-time
-- user accounts exist (system accounts are seeded above), inserts the posting row, inserts its legs,
-- inserts one chain link per account, and applies each account's net balance delta. The bigint
-- amounts arrive as JSON strings, so no precision is lost past 2^53, and they are cast here. The
-- balance step UPDATEs existing rows first, so the non-negative CHECK tests the new total rather than
-- the delta alone. It then INSERTs first-time accounts, whose first movement is always a positive
-- credit.
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

  -- Conservation check (MySQL). With direct DML on `legs` revoked, this procedure is the only writer
  -- of legs, so this assert makes it refuse an unbalanced posting. Legs that don't net to zero per
  -- currency can't be committed by any route. This is the content half of what the Postgres deferred
  -- constraint trigger enforces. Legitimate postings always balance (assertBalanced in
  -- src/ledger.ts), so this fires only on malformed input.
  IF EXISTS (
    SELECT 1 FROM legs WHERE posting_id = p_txn GROUP BY currency HAVING SUM(amount) <> 0
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conservation: posting legs do not net to zero per currency';
  END IF;

  -- Inserts one link per distinct account, carrying the account's signed running balance after this
  -- posting. That balance is its current cached balance (0 if it has no row yet) plus this posting's
  -- net delta. account_balances still holds the OLD balance here, because the balance step below runs
  -- after, so by construction this equals the value that step writes into account_balances.balance.
  -- Balance integrity later compares a cached balance to this figure at the account's head.
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

  -- Apply each account's net balance delta and advance its maintained head_hash to that account's
  -- new link hash in the same step. p_links carries one row per distinct account (the same set as
  -- p_balances), so the join pairs each balance row with its new head. UPDATE existing rows first so
  -- the non-negative CHECK tests the new total, not the delta alone.
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

-- Returns one account's cached balance (0 when it has no row yet). This is the MySQL counterpart to
-- the Postgres `account_balance` function. It is the fast read model the statement and prove paths
-- build on, behind one named, tunable access path.
CREATE FUNCTION account_balance(p_account VARCHAR(96))
RETURNS BIGINT
READS SQL DATA
BEGIN
  DECLARE v_balance BIGINT;
  SELECT balance INTO v_balance FROM account_balances WHERE account_id = p_account;
  RETURN COALESCE(v_balance, 0);
END$$

-- Enforces chain continuity. A new link's prev_hash must be the account's current head. For the first
-- link that head is GENESIS; otherwise it is an existing link's hash for that account. This blocks a
-- discontinuous link written around post_entry. The unique index already blocks a fork. (The DROP at
-- the top of the file handles re-runs.)
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

-- Enforces balance integrity. In the same CALL, post_entry writes the running total into both
-- account_balances.balance and the new chain_links row's balance_after, so these two must agree. This
-- trigger checks the cheap equivalent: a cached balance must equal the balance_after recorded at the
-- account's head (the chain_links row whose hash is the row's head_hash). That is an O(1) keyed read
-- (chain_links_account_hash_idx), instead of re-summing the whole leg history on every balance write.
-- It still rejects a hand-edited balance: a raw UPDATE that bumps balance leaves head_hash and that
-- link's balance_after untouched, so the two disagree. balance_after is itself the signed leg sum
-- through that posting, the same invariant the prover re-checks by re-summing the legs. A head_hash
-- with no matching link yields expected = 0, so only a zero balance passes (the genesis state).
-- Rationale documented in db/postgresql-schema.sql.
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

-- Give each house (system) account an empty balance row up front: balance 0, head_hash at the genesis
-- value (64 zeros). Such a row reads identically to no row at all, because headsForAccounts already
-- treats a missing row as genesis, so it shifts no balance and no hash. Its only job is to exist.
-- lockAccounts locks an account by taking `FOR UPDATE` on its balance row, and you cannot lock a row
-- that is not there yet. Without this row, the first concurrent writers to a hot shared account
-- (STORED_VALUE is touched by every top-up) find no row to lock, so none of them wait. They race to
-- extend the chain head and collide. Pre-planted, they take turns on the lock instead. A user account
-- still creates its row on its first posting, where the chain-fork retry covers that rarer race.
INSERT INTO account_balances (account_id, currency, balance, head_hash)
  SELECT id, currency, 0, REPEAT('0', 64) FROM accounts WHERE kind = 'system';

-- Schema version stamp. The engine reads this on startup and refuses to run if it does not match
-- SCHEMA_VERSION in src/schema.ts. Keep the value in lockstep with the Postgres schema and src/schema.ts.
CREATE TABLE schema_meta (version VARCHAR(32) NOT NULL);
INSERT INTO schema_meta (version) VALUES ('7');
