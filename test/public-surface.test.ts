// noinspection JSUnusedGlobalSymbols

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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allInvariantsHold,
  boot,
  CONFIG_KEYS,
  createEconomy,
  createServer,
  createWorker,
  DECLINE_KEYS,
  DEFAULT_SWEEP_LIMIT,
  describeEnv,
  DEV_RATES,
  EXPORT_FORMAT,
  feeForPrice,
  findByHash,
  idempotencyKey,
  inspectConfig,
  isRejection,
  isSuccess,
  maintenanceWindow,
  memoryPorts,
  mergeConfig,
  mulDiv,
  openPorts,
  paginate,
  parseExport,
  preflight,
  rateGte,
  REJECTION_CODES,
  REJECTION_SPEC,
  requireSuccess,
  revenueForSplit,
  SECRET_KEYS,
  systemRuntime,
  toAmount,
  usd,
  verifyExport,
} from '#src/index.ts';
import { SWEEP_NAMES } from '#src/worker/index.ts';
import {
  CLIENT_IP_HEADER,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_READ_TIMEOUT_MS,
  REQUEST_ID_HEADER,
} from '#src/server.ts';

import type { Economy, Worker } from '#src/index.ts';
import type {
  AccountRef,
  Amount,
  Checkpoint,
  EconomyStatus,
  HealthReport,
  Operation,
  Outcome,
  Posting,
  ParsedExport,
  Rate,
  Recipient,
  Rounding,
  Saga,
  ServerOptions,
  Statement,
  StoredLink,
  SweepRequest,
  VerifyReport,
} from '#src/index.ts';
import type {
  FloatFeed,
  ReconcileFeed,
  SweepName,
  SweepRun,
} from '#src/worker/index.ts';

// A public method whose parameter or return type the entry does not export is a half-exported API:
// the caller can hold the value but cannot name it. This guard fails to COMPILE the moment any type
// below stops being importable from '#src/index.ts' (Worker run I/O from '#src/worker/index.ts').
// Extend it when a new read/public method lands, so its I/O types get exported with it. There is no
// runtime assertion; tsc is the gate.

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type Read = Economy['read'];

export type PublicSurfaceGuards = [
  Expect<Exact<Parameters<Economy['submit']>[0], Operation>>,
  Expect<Exact<Awaited<ReturnType<Economy['submit']>>, Outcome>>,
  Expect<Exact<Awaited<ReturnType<Read['balance']>>, Amount>>,
  Expect<Exact<Awaited<ReturnType<Read['statement']>>, Statement>>,
  Expect<Exact<Awaited<ReturnType<Read['posting']>>, Posting | null>>,
  Expect<Exact<Awaited<ReturnType<Read['saga']>>, Saga | null>>,
  Expect<Exact<ReturnType<Read['status']>, EconomyStatus>>,
  Expect<Exact<ReturnType<Read['accounts']>, AsyncIterable<AccountRef>>>,
  Expect<Exact<ReturnType<Read['payouts']>, AsyncIterable<Saga>>>,
  Expect<Exact<ReturnType<Read['postings']>, AsyncIterable<Posting>>>,
  Expect<Exact<ReturnType<Read['lineage']>, AsyncIterable<StoredLink>>>,
  Expect<Exact<Awaited<ReturnType<Read['checkpoint']>>, Checkpoint | null>>,
  Expect<Exact<Awaited<ReturnType<Read['health']>>, HealthReport>>,
  Expect<Exact<Parameters<Worker['sweep']>[0], SweepRequest | undefined>>,
  Expect<Exact<Awaited<ReturnType<Worker['sweep']>>, SweepRun>>,
  // Promoted types resolve to the exact shapes the callables consume.
  Expect<Exact<ServerOptions, Parameters<typeof createServer>[0]>>,
  Expect<Exact<FloatFeed, NonNullable<SweepRequest['float']>>>,
  Expect<Exact<ReconcileFeed, NonNullable<SweepRequest['feed']>>>,
  Expect<Exact<SweepName, (typeof SWEEP_NAMES)[number]>>,
  Expect<Exact<ReturnType<typeof parseExport>, ParsedExport>>,
  Expect<Exact<Awaited<ReturnType<typeof verifyExport>>, VerifyReport>>,
  // The pricing and rounding helpers name their own inputs off the same entry.
  Expect<Exact<Parameters<typeof mulDiv>[3], Rounding>>,
  Expect<Exact<Parameters<typeof rateGte>[0], Rate>>,
  Expect<
    Exact<Parameters<typeof revenueForSplit>[1], ReadonlyArray<Recipient>>
  >,
  // The fee takes the priced Amount, not a bare minor count: whole-credit rounding is a rule
  // about credits and the currency is what lets it refuse a price it cannot round.
  Expect<Exact<Parameters<typeof feeForPrice>[0], Amount>>,
  Expect<Exact<Parameters<typeof revenueForSplit>[0], Amount>>,
];

test('public entry names every Economy.read and Worker I/O type (enforced at typecheck)', () => {});

test('the promoted values are live on the public entry', () => {
  assert.equal(DEFAULT_SWEEP_LIMIT, 100);
  assert.equal(typeof mergeConfig, 'function');
  assert.equal(typeof allInvariantsHold, 'function');
  assert.equal(REJECTION_CODES.includes('INSUFFICIENT_FUNDS'), true);
  assert.deepEqual(REJECTION_SPEC.INSUFFICIENT_FUNDS.fields, [
    'account',
    'need',
    'have',
  ]);
  assert.equal(CONFIG_KEYS.includes('DB_POOL_MAX'), true);
  assert.deepEqual(SECRET_KEYS, [
    'WEBHOOK_SECRET',
    'SIGNING_SECRET',
    'SIGNING_SECRETS_PRIOR',
  ]);
  assert.deepEqual(DECLINE_KEYS, [
    'DISPATCHER_DECLINED',
    'PAYEES_DECLINED',
    'ANCHOR_DECLINED',
  ]);
  assert.equal(typeof isSuccess, 'function');
  assert.equal(typeof isRejection, 'function');
  assert.equal(typeof requireSuccess, 'function');
  assert.equal(typeof usd, 'function');
  assert.equal(typeof idempotencyKey, 'function');
  assert.equal(typeof maintenanceWindow, 'function');
  assert.equal(typeof inspectConfig, 'function');
  assert.equal(typeof memoryPorts, 'function');
  assert.equal(typeof openPorts, 'function');
  assert.equal(typeof preflight, 'function');
  assert.equal(typeof describeEnv, 'function');
  assert.equal(typeof boot, 'function');
  assert.equal(typeof systemRuntime, 'function');
  assert.equal(typeof createEconomy, 'function');
  assert.equal(typeof createWorker, 'function');
  assert.equal(typeof createServer, 'function');
  assert.equal(typeof paginate, 'function');
  assert.equal(typeof findByHash, 'function');
  assert.equal(typeof parseExport, 'function');
  assert.equal(typeof EXPORT_FORMAT, 'string');
  assert.equal(typeof verifyExport, 'function');
  assert.equal(DEV_RATES.parRate, 5n);
});

test('the fee and rounding helpers are live on the public entry', () => {
  // A host that quotes a fee or compares a rate must reach the functions the posting itself
  // uses; re-deriving either off-entry is how a quote and a posting come apart.
  assert.equal(mulDiv(7n, 1n, 2n, 'ceil'), 4n);
  assert.equal(mulDiv(7n, 1n, 2n, 'floor'), 3n);
  const par = { rate: 1n, scale: 0, rateId: 'par' };
  assert.equal(rateGte(par, { rate: 100n, scale: 2, rateId: 'same' }), true);
  assert.equal(rateGte(par, { rate: 101n, scale: 2, rateId: 'above' }), false);
  // 15.3% of CREDIT:1000.00 is 153.00 exactly, and the fee rounds up to a whole credit.
  assert.equal(feeForPrice(toAmount('CREDIT', 100_000n), 1_530), 15_300n);
  assert.equal(feeForPrice(toAmount('CREDIT', 100_050n), 1_530), 15_400n);
  // Two uneven shares leave a one-unit residual, and revenue keeps it on top of the fee.
  assert.equal(
    revenueForSplit(
      toAmount('CREDIT', 100_000n),
      [
        { sellerId: 'usr_a', shareBps: 3_333 },
        { sellerId: 'usr_b', shareBps: 6_667 },
      ],
      1_530,
    ),
    15_301n,
  );
});

test('the worker facet promotes the sweep registry', () => {
  assert.equal(SWEEP_NAMES.includes('payouts'), true);
});

test('the server facet promotes the HTTP constants', () => {
  assert.equal(typeof CLIENT_IP_HEADER, 'string');
  assert.equal(typeof REQUEST_ID_HEADER, 'string');
  assert.equal(typeof DEFAULT_MAX_BODY_BYTES, 'number');
  assert.equal(typeof DEFAULT_READ_TIMEOUT_MS, 'number');
});
