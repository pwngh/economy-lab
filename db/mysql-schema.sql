-- @pwngh/economy-lab
--
-- Copyright (c) Preston Neal
--
-- This source code is licensed under the MIT license found in the
-- LICENSE.md file in the root directory of this source tree.
--
-- @license MIT

-- The MySQL counterpart to db/postgresql-schema.sql (Postgres). It is applied by
-- `applyMysqlSchema` (src/adapters/mysql.ts), which a DELIMITER-aware splitter
-- reads and runs one statement at a time (mysql2 sends one statement per query).
-- It includes the DROP TABLEs up front, so it is safe to re-run as a reset.
-- Stored routines below use `DELIMITER $$` the same way the mysql CLI does;
-- the loader understands that directive.

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

CREATE TABLE account_balances (
     account_id VARCHAR(96) PRIMARY KEY,
     currency   VARCHAR(8)  NOT NULL,
     balance    BIGINT      NOT NULL DEFAULT 0,
     CHECK (currency IN ('CREDIT', 'USD')),
     CHECK (account_id LIKE 'vrchat:%' OR balance >= 0),
     CONSTRAINT account_balances_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id)
   );

CREATE TABLE idempotency (
     `key`     VARCHAR(255) PRIMARY KEY,
     transaction JSON        NULL,
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
     KEY payout_sagas_due_idx (state, due_at)
   );

CREATE TABLE promo_grants (
     id         VARCHAR(64) PRIMARY KEY,
     user_id    VARCHAR(64) NOT NULL,
     amount     BIGINT      NOT NULL,
     currency   VARCHAR(8)  NOT NULL,
     expires_at BIGINT      NOT NULL,
     reversed   BOOLEAN     NOT NULL DEFAULT FALSE,
     CHECK (amount >= 0),
     CHECK (currency IN ('CREDIT', 'USD')),
     KEY promo_grants_due_idx (expires_at)
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

CREATE TABLE checkpoints (
     id         VARCHAR(64) PRIMARY KEY,
     root       CHAR(64)    NOT NULL,
     signature  TEXT        NOT NULL,
     count      BIGINT      NOT NULL,
     at         BIGINT      NOT NULL,
     seq        BIGINT      AUTO_INCREMENT UNIQUE,
     created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
   );

CREATE TABLE seen_webhooks (
     event_id   VARCHAR(255) PRIMARY KEY,
     response   JSON         NULL,
     created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
   );

-- ============================================================================
-- Stored routines (MySQL). The counterpart to the Postgres routines in db/postgresql-schema.sql, and like
-- those they are PURE PERSISTENCE — no business logic. Every decision is made in the application
-- (the single source of truth) and passed in as a finished value; the routines only write rows.
-- They are wrapped in `DELIMITER $$` so the semicolons inside each body are not read as statement
-- ends by the loader (and by the mysql CLI).
--
-- NOTE: on a MySQL server with binary logging enabled, creating a stored FUNCTION can require a
-- one-time `SET GLOBAL log_bin_trust_function_creators = 1` (or SUPER / SYSTEM_VARIABLES_ADMIN).
-- The PROCEDURE has no such requirement.
-- ============================================================================
DELIMITER $$

-- Persist one posting and everything derived from it in a single CALL: ensure any first-time user
-- accounts (system accounts are seeded above), insert the posting row, all of its legs, one chain
-- link per account, and apply each account's net balance delta. bigint amounts arrive as JSON
-- strings (so no precision is lost past 2^53) and are cast here. The balance step UPDATEs existing
-- rows first — so the non-negative CHECK is tested against the new total, not the delta alone —
-- then INSERTs first-time accounts, whose first movement is always a positive credit.
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

-- Return one account's cached balance (0 when it has no row yet). The MySQL counterpart to the
-- Postgres `account_balance` function — the fast read model the statement and prove paths build
-- on, behind one named, tunable access path.
CREATE FUNCTION account_balance(p_account VARCHAR(96))
RETURNS BIGINT
READS SQL DATA
BEGIN
  DECLARE v_balance BIGINT;
  SELECT balance INTO v_balance FROM account_balances WHERE account_id = p_account;
  RETURN COALESCE(v_balance, 0);
END$$

DELIMITER ;
