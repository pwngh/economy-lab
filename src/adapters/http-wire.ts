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

// Wire (de)serialization for the HTTP store adapter. `JSON.stringify` can't serialize the
// `bigint` an amount is stored as, so amounts travel as decimal strings (e.g. `'CREDIT:12.34'`)
// and parse back on arrival. Client and server both import this file, so the format stays in sync.

import { decodeAmount, encodeAmount } from '#src/money.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Transaction } from '#src/contract.ts';
import type {
  Attempt,
  Leg,
  Lot,
  Posting,
  PromoGrant,
  Saga,
  Sale,
  Statement,
  StoredLink,
  Subscription,
  Velocity,
} from '#src/ports.ts';

// Wire form of one posting leg: the account, plus its amount as a decimal string that also
// names the currency (e.g. `'CREDIT:12.34'`).
type WireLeg = { account: string; amount: string };

// Each account keeps a tamper-evident hash chain over its postings (each entry's hash covers
// the previous hash plus the new contents, so a later edit breaks the chain). Wire form of one
// account's link for a single transaction: the account, its chain hash before, and after.
type WireLink = { account: string; prevHash: string; hash: string };

function encodeLeg(leg: Leg): WireLeg {
  return { account: leg.account, amount: encodeAmount(leg.amount) };
}

function decodeLeg(wire: unknown): Leg {
  let row = wire as WireLeg;
  return { account: row.account as AccountRef, amount: amountFrom(row.amount) };
}

// Parse an encoded amount string back into an `Amount`. Currency before the colon, decimal
// value after (`'CREDIT:12.34'`), so the string is self-contained. Split and pass to `decodeAmount`.
function amountFrom(wire: string): Amount {
  let colon = wire.indexOf(':');
  let currency = wire.slice(0, colon) as Amount['currency'];
  return decodeAmount(wire.slice(colon + 1), currency);
}

/**
 * Encode each domain record into a JSON-friendly wire shape. Amounts become decimal strings;
 * everything else copies through unchanged. One function per record type the adapter sends.
 */
export let encodeWire = {
  amount: encodeAmount,

  posting: (
    posting: Posting,
  ): { txnId: string; legs: WireLeg[]; meta: Record<string, unknown> } => ({
    txnId: posting.txnId,
    legs: posting.legs.map(encodeLeg),
    meta: posting.meta,
  }),

  transaction: (transaction: Transaction): unknown => ({
    id: transaction.id,
    postedAt: transaction.postedAt,
    legs: transaction.legs.map(encodeLeg),
    links: transaction.links,
  }),

  sale: (sale: Sale): unknown => ({
    ...sale,
    price: encodeAmount(sale.price),
    fee: encodeAmount(sale.fee),
    legs: sale.legs.map(encodeLeg),
  }),

  saga: (saga: Saga): unknown => ({
    ...saga,
    reserve: encodeAmount(saga.reserve),
  }),

  sagaPatch: (patch: Partial<Saga>): unknown =>
    patch.reserve === undefined
      ? patch
      : { ...patch, reserve: encodeAmount(patch.reserve) },

  subscription: (sub: Subscription): unknown => ({
    ...sub,
    price: encodeAmount(sub.price),
  }),

  promoGrant: (grant: PromoGrant): unknown => ({
    ...grant,
    amount: encodeAmount(grant.amount),
  }),

  attempt: (attempt: Attempt): unknown => ({
    ...attempt,
    amount: encodeAmount(attempt.amount),
  }),
};

/**
 * Decode each received JSON shape back into its typed domain record (reverse of `encodeWire`).
 * Decimal-string amounts parse back into `Amount`. Fields that are plain strings on the wire but
 * distinct id types in the domain (e.g. an account reference) are cast back on arrival. One
 * function per record type the adapter receives.
 */
export let decodeWire = {
  amount: (wire: unknown): Amount => amountFrom(wire as string),

  posting: (wire: unknown): Posting => {
    let row = wire as {
      txnId: string;
      legs: unknown[];
      meta: Record<string, unknown>;
    };
    return { txnId: row.txnId, legs: row.legs.map(decodeLeg), meta: row.meta };
  },

  transaction: (wire: unknown): Transaction => {
    let row = wire as {
      id: string;
      postedAt: number;
      legs: unknown[];
      links: ReadonlyArray<WireLink>;
    };
    return {
      id: row.id,
      postedAt: row.postedAt,
      legs: row.legs.map(decodeLeg),
      links: row.links.map((link) => ({
        ...link,
        account: link.account as AccountRef,
      })),
    };
  },

  // Result of trying to claim an idempotency key (so a retry runs at most once). Either this
  // caller got the key first (`claimed: true`, do the work), or the key was already used and the
  // reply carries the transaction the earlier request recorded (`claimed: false`), which decodes
  // like any other transaction.
  claim: (
    wire: unknown,
  ): { claimed: true } | { claimed: false; transaction: Transaction } => {
    let row = wire as { claimed: boolean; transaction?: unknown };
    return row.claimed
      ? { claimed: true }
      : {
          claimed: false,
          transaction: decodeWire.transaction(row.transaction),
        };
  },

  sale: (wire: unknown): Sale => {
    let row = wire as Sale & { price: string; fee: string; legs: unknown[] };
    return {
      ...row,
      price: amountFrom(row.price),
      fee: amountFrom(row.fee),
      legs: row.legs.map(decodeLeg),
    };
  },

  saga: (wire: unknown): Saga => {
    let row = wire as Saga & { reserve: string };
    return { ...row, reserve: amountFrom(row.reserve) };
  },

  subscription: (wire: unknown): Subscription => {
    let row = wire as Subscription & { price: string };
    return { ...row, price: amountFrom(row.price) };
  },

  promoGrant: (wire: unknown): PromoGrant => {
    let row = wire as PromoGrant & { amount: string };
    return { ...row, amount: amountFrom(row.amount) };
  },

  velocity: (wire: unknown): Velocity => {
    let row = wire as Velocity & { spent: string };
    return { ...row, spent: amountFrom(row.spent) };
  },

  lot: (wire: unknown): Lot => {
    let row = wire as Lot & { amount: string };
    return { ...row, amount: amountFrom(row.amount) };
  },

  statement: (wire: unknown): Statement => {
    let row = wire as {
      account: string;
      entries: Array<{ txnId: string; amount: string; postedAt: number }>;
      cursor: string | null;
    };
    return {
      account: row.account as AccountRef,
      entries: row.entries.map((entry) => ({
        txnId: entry.txnId,
        amount: amountFrom(entry.amount),
        postedAt: entry.postedAt,
      })),
      cursor: row.cursor,
    };
  },

  storedLink: (wire: unknown): StoredLink => {
    let row = wire as {
      txnId: string;
      legs: unknown[];
      meta: Record<string, unknown>;
      prevHash: string;
      hash: string;
    };
    return {
      txnId: row.txnId,
      legs: row.legs.map(decodeLeg),
      meta: row.meta,
      prevHash: row.prevHash,
      hash: row.hash,
    };
  },
};
