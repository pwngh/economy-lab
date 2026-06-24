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

-- Pin the database default collation FIRST, so every table below (none declare their own) inherits
-- it. The strings JSON_TABLE produces inside post_entry are utf8mb4_0900_ai_ci; matching the tables
-- to that avoids "Illegal mix of collations" on the `ab.account_id = d.account` joins. Applied the
-- same way by `applyMysqlSchema` and by `mysql < db/mysql-schema.sql` (scripts/migrate.sh).
ALTER DATABASE CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Drop stored routines first: unlike DROP TABLE they have no IF-EXISTS-on-CREATE form, so re-apply
-- fails with ER_SP_ALREADY_EXISTS without an explicit drop. (CREATE TABLE below is guarded by the
-- DROP TABLEs.)
DROP PROCEDURE IF EXISTS post_entry;

DROP FUNCTION IF EXISTS account_balance;

DROP TRIGGER IF EXISTS chain_links_continuity;

DROP TRIGGER IF EXISTS account_balances_integrity_ins;

DROP TRIGGER IF EXISTS account_balances_integrity_upd;

DROP TABLE IF EXISTS seen_webhooks;

DROP TABLE IF EXISTS checkpoints;

DROP TABLE IF EXISTS trust_attempts;

DROP TABLE IF EXISTS promo_grants;

DROP TABLE IF EXISTS subscriptions;

DROP TABLE IF EXISTS entitlements;

DROP TABLE IF EXISTS payout_sagas;

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
     CHECK (currency IN ('CREDIT', 'USD'))
   );

INSERT INTO accounts (id, kind, currency) VALUES
     ('vrchat:trust_cash',     'system', 'USD'),
     ('vrchat:revenue',        'system', 'CREDIT'),
     ('vrchat:stored_value',   'system', 'CREDIT'),
     ('vrchat:payout_reserve', 'system', 'CREDIT'),
     ('vrchat:receivable',     'system', 'CREDIT'),
     ('vrchat:promo_float',    'system', 'CREDIT'),
     ('vrchat:usd_clearing',   'system', 'USD'),
     ('vrchat:revenue_usd',    'system', 'USD'),
     ('vrchat:opening_equity', 'system', 'CREDIT');

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
     CONSTRAINT legs_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id),
     KEY legs_account_idx (account_id),
     KEY legs_posting_idx (posting_id)
   );

CREATE TABLE chain_links (
     posting_id VARCHAR(64) NOT NULL,
     account_id VARCHAR(96) NOT NULL,
     prev_hash  CHAR(64)    NOT NULL,
     hash       CHAR(64)    NOT NULL,
     PRIMARY KEY (posting_id, account_id),
     CONSTRAINT chain_links_posting_fk FOREIGN KEY (posting_id) REFERENCES postings (id),
     CONSTRAINT chain_links_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id),
     UNIQUE KEY chain_links_account_prev_uq (account_id, prev_hash),
     KEY chain_links_account_idx (account_id)
   );

-- account_balances: cached per-account balance read model. Rationale/invariants (non-negative
-- overdraft guard, always re-derivable from legs) documented in db/postgresql-schema.sql.
CREATE TABLE account_balances (
     account_id VARCHAR(96) PRIMARY KEY,
     currency   VARCHAR(8)  NOT NULL,
     balance    BIGINT      NOT NULL DEFAULT 0,
     CHECK (currency IN ('CREDIT', 'USD')),
     CHECK (account_id LIKE 'vrchat:%' OR balance >= 0),
     CONSTRAINT account_balances_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id)
   );

-- idempotency: exactly-once retry guard. Rationale/invariants documented in
-- db/postgresql-schema.sql (idempotency banner).
CREATE TABLE idempotency (
     `key`     VARCHAR(255) PRIMARY KEY,
     transaction JSON        NULL,  -- the recorded result, replayed verbatim on a duplicate; NULL while a row is claimed-but-not-yet-recorded (claim inserts a placeholder to hold the row lock; record fills it)
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
     -- MySQL has no partial index; the PG WHERE-predicate (status/state/reversed) becomes the leading composite-key column so the sweep/relay scan stays narrow.
     KEY outbox_pending_idx (status, created_at)
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
     dead_letter_reason VARCHAR(255),
     CHECK (reserve > 0),
     CHECK (state IN ('REQUESTED', 'RESERVED', 'SUBMITTED', 'SETTLED', 'FAILED')),
     -- MySQL has no partial index; the PG WHERE-predicate (status/state/reversed) becomes the leading composite-key column so the sweep/relay scan stays narrow.
     KEY payout_sagas_due_idx (state, due_at)
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
     -- MySQL has no partial index; the PG WHERE-predicate (status/state/reversed) becomes the leading composite-key column so the sweep/relay scan stays narrow.
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
     -- MySQL has no partial index; the PG WHERE-predicate (status/state/reversed) becomes the leading composite-key column so the sweep/relay scan stays narrow.
     KEY subscriptions_due_idx (state, next_due_at)
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
-- Stored routines (MySQL) + the engine's invariant enforcement. Counterpart to the Postgres routines
-- in db/postgresql-schema.sql. The application computes the values and passes them in; the routines
-- write the rows. But the database — not the application — is the primary enforcer of the ledger
-- invariants here, not a safety net: post_entry asserts conservation and is the SOLE writer of
-- `legs` (direct DML is revoked from the app role; see adversarial-engines.ts), and the triggers
-- below enforce chain continuity and balance integrity; the CHECK constraints above cover
-- no-overdraft and the primary keys cover exactly-once. Wrapped in `DELIMITER $$` so the
-- loader (and the mysql CLI) don't read the semicolons inside each body as statement ends.
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
-- DML stays granted on every other table on purpose: chain continuity, balance integrity, overdraft,
-- and exactly-once must each be reachable by a raw write so their own triggers, CHECKs, and keys do
-- the rejecting; only `legs` is sealed. post_entry declares no SQL SECURITY clause, so it runs as
-- DEFINER: invoked by economy_app it still writes `legs` with the schema owner's rights, balanced by
-- construction. That assumes the DEFINER (whoever applies this file) keeps `legs` DML and is a
-- different identity from economy_app.
--
-- Not executed here: the schema is applied by one privileged connection (scripts/migrate.sh), the
-- database name isn't known statically, and provisioning a second login is a deployment rail this lab
-- stubs. test/conformance/adversarial-engines.ts builds exactly this role and proves a raw
-- unbalanced-leg INSERT is refused while balanced legs still post through post_entry.
-- ============================================================================
DELIMITER $$

-- Persist one posting and everything derived from it in a single CALL: ensure any first-time user
-- accounts (system accounts are seeded above), insert the posting row, its legs, one chain link per
-- account, and apply each account's net balance delta. bigint amounts arrive as JSON strings (no
-- precision lost past 2^53) and are cast here. The balance step UPDATEs existing rows first, so the
-- non-negative CHECK tests the new total rather than the delta alone, then INSERTs first-time
-- accounts, whose first movement is always a positive credit.
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

  -- conservation (MySQL). With direct DML on `legs` revoked, this procedure is
  -- the only writer of legs, so this assert makes it refuse an unbalanced posting: legs that don't
  -- net to zero per currency can't be committed by any route, the content half of what the Postgres
  -- deferred constraint trigger enforces. Legitimate postings always balance (assertBalanced in
  -- src/ledger.ts), so this fires only on malformed input.
  IF EXISTS (
    SELECT 1 FROM legs WHERE posting_id = p_txn GROUP BY currency HAVING SUM(amount) <> 0
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conservation: posting legs do not net to zero per currency';
  END IF;

  INSERT INTO chain_links (posting_id, account_id, prev_hash, hash)
    SELECT p_txn, c.account, c.prev_hash, c.hash
      FROM JSON_TABLE(p_links, '$[*]' COLUMNS (
        account   VARCHAR(96) PATH '$.account',
        prev_hash VARCHAR(64) PATH '$.prev_hash',
        hash      VARCHAR(64) PATH '$.hash'
      )) AS c;

  UPDATE account_balances ab
    JOIN JSON_TABLE(p_balances, '$[*]' COLUMNS (
      account VARCHAR(96) PATH '$.account',
      delta   VARCHAR(32) PATH '$.delta'
    )) AS d ON ab.account_id = d.account
    SET ab.balance = ab.balance + CAST(d.delta AS SIGNED);

  INSERT INTO account_balances (account_id, currency, balance)
    SELECT d.account, d.currency, CAST(d.delta AS SIGNED)
      FROM JSON_TABLE(p_balances, '$[*]' COLUMNS (
        account  VARCHAR(96) PATH '$.account',
        currency VARCHAR(8)  PATH '$.currency',
        delta    VARCHAR(32) PATH '$.delta'
      )) AS d
     WHERE NOT EXISTS (
       SELECT 1 FROM account_balances ab WHERE ab.account_id = d.account
     )
    ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance);
END$$

-- Return one account's cached balance (0 when it has no row yet). MySQL counterpart to the Postgres
-- `account_balance` function: the fast read model the statement and prove paths build on, behind one
-- named, tunable access path.
CREATE FUNCTION account_balance(p_account VARCHAR(96))
RETURNS BIGINT
READS SQL DATA
BEGIN
  DECLARE v_balance BIGINT;
  SELECT balance INTO v_balance FROM account_balances WHERE account_id = p_account;
  RETURN COALESCE(v_balance, 0);
END$$

-- chain continuity: a new link's prev_hash must be the account's current head,
-- GENESIS for the first link, else an existing link's hash for that account. Blocks a discontinuous
-- link written around post_entry; the unique index already blocks a fork. (DROP at top for re-runs.)
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

-- balance integrity: account_balances must equal the legs' net for the account,
-- signed by its normal side (debit-normal +SUM, else -SUM). post_entry writes exactly that, so this
-- rejects only a hand-edited (drifted) balance. Debit-normal set mirrors isDebitNormal (accounts.ts).
CREATE TRIGGER account_balances_integrity_ins BEFORE INSERT ON account_balances
FOR EACH ROW
BEGIN
  DECLARE expected BIGINT;
  SET expected = (CASE WHEN NEW.account_id IN (
      'vrchat:trust_cash','vrchat:usd_clearing','vrchat:revenue_usd',
      'vrchat:stored_value','vrchat:receivable','vrchat:promo_float','vrchat:opening_equity'
    ) THEN 1 ELSE -1 END)
    * COALESCE((SELECT SUM(amount) FROM legs WHERE account_id = NEW.account_id), 0);
  IF NEW.balance <> expected THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'balance integrity: cached balance <> signed leg sum';
  END IF;
END$$

CREATE TRIGGER account_balances_integrity_upd BEFORE UPDATE ON account_balances
FOR EACH ROW
BEGIN
  DECLARE expected BIGINT;
  SET expected = (CASE WHEN NEW.account_id IN (
      'vrchat:trust_cash','vrchat:usd_clearing','vrchat:revenue_usd',
      'vrchat:stored_value','vrchat:receivable','vrchat:promo_float','vrchat:opening_equity'
    ) THEN 1 ELSE -1 END)
    * COALESCE((SELECT SUM(amount) FROM legs WHERE account_id = NEW.account_id), 0);
  IF NEW.balance <> expected THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'balance integrity: cached balance <> signed leg sum';
  END IF;
END$$

DELIMITER ;
