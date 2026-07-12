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

import { balanceDelta } from '#src/ledger.ts';
import { currency, walletKindOf } from '#src/accounts.ts';

import type { Posting } from '#src/ports.ts';
import type { Link } from '#src/engines/sql-shared.ts';

/**
 * Selects which placeholder style the routines emit. Postgres uses `$1,$2,...` and MySQL uses
 * `?,?,...`.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the stored-routine boundary.
 */
export type SqlDialect = 'postgres' | 'mysql';

/**
 * Runs SQL with positional params and returns the rows. Each engine wraps its driver to this
 * shape (Postgres `pool.query`, MySQL `rows()`), so the routines below are written once for both
 * backends.
 */
export type SqlQuery = (
  sql: string,
  params: ReadonlyArray<unknown>,
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

// A routine name is interpolated into the SQL because a bound param cannot name a routine. Restrict
// it to a plain SQL identifier to block injection. Every call site passes a hard-coded constant, so
// this never fires today. It is a backstop against a future caller that builds a name from input.
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function safeName(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unsafe SQL routine name: ${JSON.stringify(name)}.`);
  }
  return name;
}

function placeholders(dialect: SqlDialect, count: number): string {
  return Array.from({ length: count }, (_, i) =>
    dialect === 'postgres' ? `$${i + 1}` : '?',
  ).join(', ');
}

export async function callProcedure(
  query: SqlQuery,
  dialect: SqlDialect,
  name: string,
  args: ReadonlyArray<unknown>,
): Promise<void> {
  const sql = `CALL ${safeName(name)}(${placeholders(dialect, args.length)})`;
  await query(sql, args);
}

export async function callFunction(
  query: SqlQuery,
  dialect: SqlDialect,
  name: string,
  args: ReadonlyArray<unknown>,
): Promise<unknown> {
  const sql = `SELECT ${safeName(name)}(${placeholders(dialect, args.length)}) AS result`;
  const out = await query(sql, args);
  return out.rows[0]?.result ?? null;
}

// --- post_entry: preparing its arguments from a posting ---------------------------

/**
 * Persistence-only arguments for the `post_entry` procedure. The business decisions stay in TS: the
 * direction per account (`balanceDelta`), the net delta summed across a posting's legs that touch
 * one account, the first-time user-account kind, and the currency. The procedure only writes rows.
 * bigints are carried as strings so the JSON keeps full precision past 2^53.
 */
export interface PostEntryArgs {
  // Amounts are signed: a debit is positive, a credit is negative.
  legs: Array<{ account: string; currency: string; amount: string }>;

  links: Array<{ account: string; prev_hash: string; hash: string }>;

  // The net change to each account's cached balance. Each delta is already `balanceDelta`-signed
  // and summed across that account's legs.
  balances: Array<{ account: string; currency: string; delta: string }>;

  newAccounts: Array<{ id: string; kind: string; currency: string }>;
}

/**
 * Turns a posting and its pre-computed chain links into the {@link PostEntryArgs} the `post_entry`
 * procedure persists — the one place the per-account math lives.
 */
export function postEntryArgs(
  posting: Posting,
  links: ReadonlyArray<Link>,
): PostEntryArgs {
  const legs = posting.legs.map((leg) => ({
    account: leg.account,
    currency: leg.amount.currency,
    amount: leg.amount.minor.toString(),
  }));

  const linkRows = links.map((link) => ({
    account: link.account,
    prev_hash: link.prevHash,
    hash: link.hash,
  }));

  // A posting can touch one account in several legs (a promo-funded spend credits a seller twice),
  // so sum each account's `balanceDelta` into one figure — the same total the per-leg `foldBalance`
  // would reach.
  const deltaByAccount = new Map<string, bigint>();
  const currencyByAccount = new Map<string, string>();
  for (const leg of posting.legs) {
    const prior = deltaByAccount.get(leg.account) ?? 0n;
    deltaByAccount.set(leg.account, prior + balanceDelta(leg).minor);
    currencyByAccount.set(leg.account, leg.amount.currency);
  }
  const balances = [...deltaByAccount].map(([account, delta]) => ({
    account,
    currency: currencyByAccount.get(account) as string,
    delta: delta.toString(),
  }));

  // Collect the user accounts to create on first use, distinct and in first-seen order. A platform
  // account reads as null (no `:kind` suffix): the schema seeds it, so this code never creates it.
  const newAccounts: PostEntryArgs['newAccounts'] = [];
  const seen = new Set<string>();
  for (const leg of posting.legs) {
    if (seen.has(leg.account)) {
      continue;
    }
    seen.add(leg.account);
    const kind = walletKindOf(leg.account);
    if (kind !== null) {
      newAccounts.push({
        id: leg.account,
        kind,
        currency: currency(leg.account),
      });
    }
  }

  return { legs, links: linkRows, balances, newAccounts };
}
