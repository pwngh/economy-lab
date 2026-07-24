/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// Rewrites the one canonical schema (db/postgresql-schema.sql) into its hash-partitioned
// variant: the three growth tables become partitioned parents with eight hash partitions each,
// and everything else passes through byte-identical, so the two layouts cannot drift apart.
// Postgres requires every unique constraint on a partitioned table to include the partition
// key; each rewrite's replacement text states how its key choice preserves uniqueness. MySQL
// has no partitioned variant, deliberately: MySQL forbids foreign keys on partitioned tables,
// and referential enforcement is not traded for partition locality.

const PARTITIONS = 8;

type Rewrite = { anchor: string; replacement: string };

function hashPartitions(table: string): string {
  return Array.from(
    { length: PARTITIONS },
    (_, i) =>
      `create table ${table}_p${i} partition of ${table} for values with (modulus ${PARTITIONS}, remainder ${i});`,
  ).join('\n');
}

const REWRITES: ReadonlyArray<Rewrite> = [
  {
    anchor: `create table postings (
  id         text        primary key,
  meta       jsonb       not null default '{}',
  posted_at  bigint      not null,
  seq        bigserial   unique,
  created_at timestamptz not null default now()
);`,
    replacement: `create table postings (
  id         text        primary key,
  meta       jsonb       not null default '{}',
  posted_at  bigint      not null,
  -- No UNIQUE here: a partitioned unique constraint must include the partition key (id), and
  -- seq is generated from the owned sequence, which guarantees uniqueness on its own. The
  -- plain index keeps the seq-ordered walks (linksPage, historySize) fast.
  seq        bigserial,
  created_at timestamptz not null default now()
) partition by hash (id);
${hashPartitions('postings')}
create index postings_seq_idx on postings (seq);`,
  },
  {
    anchor: `create table legs (
  id         bigserial   primary key,
  posting_id text        not null references postings (id),
  account_id text        not null,
  currency   text        not null check (currency in ('CREDIT', 'USD')),
  amount     bigint      not null check (amount <> 0),
  -- Composite FK to accounts(id, currency): a leg's currency must match its account's, enforced
  -- natively. Rejects a raw cross-currency leg (e.g. balanced USD legs on CREDIT accounts) that the
  -- per-currency conservation check would let pass. Subsumes the plain account_id reference.
  foreign key (account_id, currency) references accounts (id, currency)
);`,
    replacement: `create table legs (
  id         bigserial,
  posting_id text        not null references postings (id),
  account_id text        not null,
  currency   text        not null check (currency in ('CREDIT', 'USD')),
  amount     bigint      not null check (amount <> 0),
  -- The surrogate key widens to include the partition key; id stays unique by generation.
  primary key (posting_id, id),
  -- Composite FK to accounts(id, currency): a leg's currency must match its account's, enforced
  -- natively. Rejects a raw cross-currency leg (e.g. balanced USD legs on CREDIT accounts) that the
  -- per-currency conservation check would let pass. Subsumes the plain account_id reference.
  foreign key (account_id, currency) references accounts (id, currency)
) partition by hash (posting_id);
${hashPartitions('legs')}`,
  },
  {
    anchor: `create table chain_links (
  posting_id text        not null references postings (id),
  account_id text        not null references accounts (id),
  prev_hash  text        not null,
  hash       text        not null,
  -- The account's signed running balance right after this link, the same figure post_entry writes into
  -- account_balances.balance, so the balance-integrity check compares cached balance to chain head in
  -- O(1) instead of re-summing legs. A projection, not the source of truth: prove() re-sums and wins.
  balance_after bigint   not null default 0,
  primary key (posting_id, account_id)
);`,
    replacement: `create table chain_links (
  posting_id text        not null references postings (id),
  account_id text        not null references accounts (id),
  prev_hash  text        not null,
  hash       text        not null,
  -- The account's signed running balance right after this link, the same figure post_entry writes into
  -- account_balances.balance, so the balance-integrity check compares cached balance to chain head in
  -- O(1) instead of re-summing legs. A projection, not the source of truth: prove() re-sums and wins.
  balance_after bigint   not null default 0,
  primary key (posting_id, account_id)
) partition by hash (account_id);
${hashPartitions('chain_links')}`,
  },
];

/**
 * The canonical schema, rewritten to the partitioned layout. Throws when a rewrite anchor no
 * longer matches the canonical text — the file changed and the transform must be updated with
 * it, not silently skipped.
 */
export function partitionedSchemaSql(canonical: string): string {
  let sql = canonical;
  for (const { anchor, replacement } of REWRITES) {
    if (!sql.includes(anchor)) {
      throw new Error(
        `partitioned layout: canonical schema anchor drifted: ${anchor.slice(0, 60)}...`,
      );
    }
    sql = sql.replace(anchor, replacement);
  }
  return sql;
}
