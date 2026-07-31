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

import { OPERATION_FIELDS } from '#src/wire-contract.ts';
import { toAmount } from '#src/money.ts';
import { spendable } from '#src/accounts.ts';

import type { Operation } from '#src/contract.ts';

/** The system principal every non-operator sample acts as. */
export const SAMPLE_ACTOR = {
  kind: 'system',
  service: 'webhook:billing',
} as const;
const OPERATOR = { kind: 'operator', operatorId: 'op_7' } as const;
/** The idempotency key every sample carries. */
export const SAMPLE_KEY = 'idem_codec:1';

/**
 * One well-formed Operation per kind, carrying every field its kind declares — optional ones
 * included, so a field left out of a sample is a field no test drives.
 *
 * The mapped type is the completeness proof at compile time: a new arm of Operation stops every
 * importer compiling until it has a sample. The run-time half is the roster reconciliation each
 * importer runs against {@link OPERATION_FIELDS} — the complete table, so a server-set field is
 * sampled like any other.
 */
export const SAMPLES: {
  readonly [K in Operation['kind']]: Extract<Operation, { kind: K }>;
} = {
  topUp: {
    kind: 'topUp',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    userId: 'usr_buyer',
    amount: toAmount('CREDIT', 60_000n),
    source: 'card',
  },
  spend: {
    kind: 'spend',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    orderId: 'ord_8821',
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: toAmount('CREDIT', 40_000n),
    recipients: [
      { sellerId: 'usr_creator', shareBps: 7_500 },
      { sellerId: 'usr_collab', shareBps: 2_500 },
    ],
    ageRestricted: true,
    giftTo: 'usr_friend',
  },
  refund: {
    kind: 'refund',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    orderId: 'ord_8821',
    reason: 'buyer request',
  },
  clawback: {
    kind: 'clawback',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    userId: 'usr_buyer',
    amount: toAmount('CREDIT', 60_000n),
    orderId: 'ord_8821',
    key: 'dp_19xk',
    reason: 'fraudulent_charge',
  },
  requestPayout: {
    kind: 'requestPayout',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    userId: 'usr_seller',
    amount: toAmount('CREDIT', 2_500_000n),
  },
  subscribe: {
    kind: 'subscribe',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    userId: 'usr_buyer',
    sellerId: 'usr_seller',
    sku: 'club_pass',
    price: toAmount('CREDIT', 50_000n),
    periodMs: 2_592_000_000,
  },
  cancelSubscription: {
    kind: 'cancelSubscription',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    subscriptionId: 'sub_4f2a',
  },
  grantEntitlement: {
    kind: 'grantEntitlement',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    userId: 'usr_owner',
    sku: 'wrld_pass',
    // expiresAt is null rather than absent: null is the spelling that says "never", and it is the
    // one value the Amount-brand walk short-circuits on.
    attrs: { quantity: 1, version: 2, expiresAt: null, source: 'support_comp' },
  },
  revokeEntitlement: {
    kind: 'revokeEntitlement',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    userId: 'usr_owner',
    sku: 'wrld_pass',
    reason: 'chargeback',
  },
  grantPromo: {
    kind: 'grantPromo',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    userId: 'usr_buyer',
    amount: toAmount('CREDIT', 25_000n),
    expiresAt: 1_800_000_000_000,
  },
  adjust: {
    kind: 'adjust',
    idempotencyKey: SAMPLE_KEY,
    actor: OPERATOR,
    // An AccountRef carries a colon, which is also the amount grammar's separator. It must come
    // back as the string it went in as.
    account: spendable('usr_a1'),
    // The one operation whose amount may be negative, so the sign rides the round-trip too.
    amount: toAmount('CREDIT', -25_000n),
    reason: 'reconciliation: double-posted top-up',
  },
  reverse: {
    kind: 'reverse',
    idempotencyKey: SAMPLE_KEY,
    actor: OPERATOR,
    txnId: 'txn_5f21',
    reason: 'reconciliation: duplicate posting',
  },
  reversePayout: {
    kind: 'reversePayout',
    idempotencyKey: SAMPLE_KEY,
    actor: OPERATOR,
    userId: 'usr_seller',
    sagaId: 'pay_9f2c',
    reason: 'fraud hold',
    providerReported: true,
  },
  settlePayout: {
    kind: 'settlePayout',
    idempotencyKey: SAMPLE_KEY,
    actor: SAMPLE_ACTOR,
    sagaId: 'pay_9f2c',
    providerRef: 'acct_77/ps_8821',
    providerAmount: toAmount('USD', 12_500n),
  },
};

/** The three fields that ride every variant, which the field tables exclude from their per-kind rows. */
export const COMMON = ['kind', 'idempotencyKey', 'actor'];

/** Every kind the wire contract declares, in table order. */
export const KINDS = Object.keys(OPERATION_FIELDS) as Operation['kind'][];

/** The fields one kind declares, without the three common ones. */
export const declaredFields = (kind: Operation['kind']): string[] =>
  Object.keys(OPERATION_FIELDS[kind]);
