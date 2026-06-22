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
import { currency } from '#src/accounts.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Posting } from '#src/ports.ts';

// One account's chain step for a posting: account, head hash before, head hash after. Adapters
// compute these (hash is SHA-256, in application code) and pass them in; this module only writes
// them to the database.
type Link = { account: AccountRef; prevHash: string; hash: string };

/** Which SQL dialect's placeholder style to emit: Postgres `$1,$2,…` or MySQL `?,?,…`. */
export type SqlDialect = 'postgres' | 'mysql';

/**
 * Run SQL with positional params, return the rows. Each adapter wraps its driver to this shape
 * (Postgres `pool.query`, MySQL `rows()`), so the routines below are written once for both backends.
 */
export type SqlQuery = (
  sql: string,
  params: ReadonlyArray<unknown>,
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

// A routine name is interpolated into the SQL (a bound param can't name a routine), so restrict it
// to a plain SQL identifier against injection. Every call site passes a hard-coded constant, so
// this never fires today; it's a backstop against a future caller building a name from input.
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function safeName(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`unsafe SQL routine name: ${JSON.stringify(name)}`);
  }
  return name;
}

function placeholders(dialect: SqlDialect, count: number): string {
  return Array.from({ length: count }, (_, i) =>
    dialect === 'postgres' ? `$${i + 1}` : '?',
  ).join(', ');
}

// Invoke a stored procedure for its side effects (no value read back). Builds the `CALL` in the
// backend's placeholder style and runs it. No business logic, just call mechanics shared by the
// Postgres and MySQL adapters. Values are prepared by the application (see {@link postEntryArgs});
// the routine only persists them.
export async function callProcedure(
  query: SqlQuery,
  dialect: SqlDialect,
  name: string,
  args: ReadonlyArray<unknown>,
): Promise<void> {
  let sql = `CALL ${safeName(name)}(${placeholders(dialect, args.length)})`;
  await query(sql, args);
}

// Invoke a stored function and return its single scalar result (selected as `result`). Same
// mechanics as {@link callProcedure}, in a `SELECT` shape.
export async function callFunction(
  query: SqlQuery,
  dialect: SqlDialect,
  name: string,
  args: ReadonlyArray<unknown>,
): Promise<unknown> {
  let sql = `SELECT ${safeName(name)}(${placeholders(dialect, args.length)}) AS result`;
  let out = await query(sql, args);
  return out.rows[0]?.result ?? null;
}

// --- post_entry: preparing its arguments from a posting ---------------------------

/**
 * Persistence-only arguments for the `post_entry` procedure. The business decisions live in TS:
 * direction per account (`balanceDelta`), summing a posting's legs to one account into a net delta,
 * first-time user-account kind, and currency. The procedure just writes rows. bigints are carried
 * as strings so the JSON keeps full precision past 2^53.
 */
export interface PostEntryArgs {
  // The raw legs (signed: debit +, credit −), one row per leg.
  legs: Array<{ account: string; currency: string; amount: string }>;

  // One chain link per distinct account the posting touched.
  links: Array<{ account: string; prev_hash: string; hash: string }>;

  // The net change to each account's cached balance — already `balanceDelta`-signed and summed
  // across that account's legs.
  balances: Array<{ account: string; currency: string; delta: string }>;

  // The user accounts (`usr_…:<kind>`) to create on first use; system accounts are seeded by the
  // schema, so they are never listed here.
  newAccounts: Array<{ id: string; kind: string; currency: string }>;
}

/**
 * Turn a posting and its pre-computed chain links into the {@link PostEntryArgs} the `post_entry`
 * procedure persists. The one place the per-account math lives; mirrors the old per-leg
 * `foldBalance` / `ensureAccount` path, so the procedure write is behavior-identical in one
 * round-trip instead of many.
 */
export function postEntryArgs(
  posting: Posting,
  links: ReadonlyArray<Link>,
): PostEntryArgs {
  let legs = posting.legs.map((leg) => ({
    account: leg.account,
    currency: leg.amount.currency,
    amount: leg.amount.minor.toString(),
  }));

  let linkRows = links.map((link) => ({
    account: link.account,
    prev_hash: link.prevHash,
    hash: link.hash,
  }));

  // Net balance delta per account: a posting can touch one account in several legs (e.g. a
  // promo-funded spend credits a seller twice), so sum each account's `balanceDelta` into one
  // figure, the same total the per-leg `foldBalance` would reach.
  let deltaByAccount = new Map<string, bigint>();
  let currencyByAccount = new Map<string, string>();
  for (let leg of posting.legs) {
    let prior = deltaByAccount.get(leg.account) ?? 0n;
    deltaByAccount.set(leg.account, prior + balanceDelta(leg).minor);
    currencyByAccount.set(leg.account, leg.amount.currency);
  }
  let balances = [...deltaByAccount].map(([account, delta]) => ({
    account,
    currency: currencyByAccount.get(account) as string,
    delta: delta.toString(),
  }));

  // The user accounts to create on first use, distinct and in first-seen order.
  let newAccounts: PostEntryArgs['newAccounts'] = [];
  let seen = new Set<string>();
  for (let leg of posting.legs) {
    if (seen.has(leg.account)) {
      continue;
    }
    seen.add(leg.account);
    let kind = userAccountKind(leg.account);
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

// The kind of a user account (`usr_…:spendable|earned|promo`), or null for a platform account
// (which the schema already seeded, so it is never created here). The same suffix rule the
// adapters' account-ensure used.
function userAccountKind(
  account: string,
): 'spendable' | 'earned' | 'promo' | null {
  let colon = account.lastIndexOf(':');
  if (colon < 0) {
    return null;
  }
  let suffix = account.slice(colon + 1);
  if (suffix === 'spendable' || suffix === 'earned' || suffix === 'promo') {
    return suffix;
  }
  return null;
}
