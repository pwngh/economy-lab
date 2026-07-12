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

import {
  decodeAmountWire,
  decodeAmounts,
  encodeAmount,
  encodeAmounts,
} from '#src/money.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Operation, Transaction } from '#src/contract.ts';
import type {
  Attempt,
  InboxEntry,
  Leg,
  Lot,
  Movement,
  Posting,
  PromoGrant,
  Saga,
  Sale,
  Statement,
  StoredLink,
  Subscription,
  Velocity,
} from '#src/ports.ts';

type WireLeg = { account: string; amount: string };

// Wire form of one account's tamper-evident hash-chain link for a single transaction.
type WireLink = { account: string; prevHash: string; hash: string };

function encodeLeg(leg: Leg): WireLeg {
  return { account: leg.account, amount: encodeAmount(leg.amount) };
}

function decodeLeg(wire: unknown): Leg {
  const row = wire as WireLeg;
  return { account: row.account as AccountRef, amount: amountFrom(row.amount) };
}

function amountFrom(wire: string): Amount {
  return decodeAmountWire(wire);
}

// An inbox row carries a whole Operation whose money fields differ by `kind`; the generic
// Amount-brand walk (encodeAmounts/decodeAmounts) codes them all with no per-kind branch to drift.

/**
 * Encoders to the JSON wire shape, one per record type the adapter sends.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for how the store adapter ports move records over the wire.
 */
export const encodeWire = {
  amount: encodeAmount,

  movement: (movement: Movement): unknown => ({
    ...movement,
    legs: movement.legs.map(encodeLeg),
  }),

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
    payoutUsd: saga.payoutUsd === null ? null : encodeAmount(saga.payoutUsd),
  }),

  sagaPatch: (patch: Partial<Saga>): unknown => {
    const out: Record<string, unknown> = { ...patch };
    if (patch.reserve !== undefined) {
      out.reserve = encodeAmount(patch.reserve);
    }
    if (patch.payoutUsd !== undefined) {
      out.payoutUsd =
        patch.payoutUsd === null ? null : encodeAmount(patch.payoutUsd);
    }
    return out;
  },

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

  inboxEntry: (entry: InboxEntry): unknown => ({
    ...entry,
    operation: encodeAmounts(entry.operation),
  }),
};

/**
 * Decoders back to typed domain records, one per record type the adapter receives (reverse of
 * `encodeWire`). Plain wire strings that are branded id types in the domain are cast back here.
 */
export const decodeWire = {
  amount: (wire: unknown): Amount => amountFrom(wire as string),

  movement: (wire: unknown): Movement => {
    const row = wire as Omit<Movement, 'legs'> & { legs: unknown[] };
    return { ...row, legs: row.legs.map(decodeLeg) };
  },

  posting: (wire: unknown): Posting => {
    const row = wire as {
      txnId: string;
      legs: unknown[];
      meta: Record<string, unknown>;
    };
    return { txnId: row.txnId, legs: row.legs.map(decodeLeg), meta: row.meta };
  },

  transaction: (wire: unknown): Transaction => {
    const row = wire as {
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

  // Wire result of an idempotency-key claim: `claimed: true` means do the work; `claimed: false`
  // carries the transaction the earlier request recorded.
  claim: (
    wire: unknown,
  ): { claimed: true } | { claimed: false; transaction: Transaction } => {
    const row = wire as { claimed: boolean; transaction?: unknown };
    return row.claimed
      ? { claimed: true }
      : {
          claimed: false,
          transaction: decodeWire.transaction(row.transaction),
        };
  },

  sale: (wire: unknown): Sale => {
    const row = wire as Sale & { price: string; fee: string; legs: unknown[] };
    return {
      ...row,
      price: amountFrom(row.price),
      fee: amountFrom(row.fee),
      legs: row.legs.map(decodeLeg),
    };
  },

  saga: (wire: unknown): Saga => {
    const row = wire as Saga & { reserve: string; payoutUsd: string | null };
    return {
      ...row,
      reserve: amountFrom(row.reserve),
      payoutUsd: row.payoutUsd === null ? null : amountFrom(row.payoutUsd),
    };
  },

  subscription: (wire: unknown): Subscription => {
    const row = wire as Subscription & { price: string };
    return { ...row, price: amountFrom(row.price) };
  },

  promoGrant: (wire: unknown): PromoGrant => {
    const row = wire as PromoGrant & { amount: string };
    return { ...row, amount: amountFrom(row.amount) };
  },

  inboxEntry: (wire: unknown): InboxEntry => {
    const row = wire as InboxEntry & { operation: unknown };
    return { ...row, operation: decodeAmounts(row.operation) as Operation };
  },

  velocity: (wire: unknown): Velocity => {
    const row = wire as Velocity & { spent: string };
    return { ...row, spent: amountFrom(row.spent) };
  },

  lot: (wire: unknown): Lot => {
    const row = wire as Lot & { amount: string };
    return { ...row, amount: amountFrom(row.amount) };
  },

  statement: (wire: unknown): Statement => {
    const row = wire as {
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
    const row = wire as {
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
