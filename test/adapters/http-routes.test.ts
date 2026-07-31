/// <reference types="node" />
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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createStoreServer, httpStore } from '#src/adapters/http.ts';
import { ERROR_CODES } from '#src/errors.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { SYSTEM } from '#src/accounts.ts';
import { credit, topUp } from '#test/support/builders.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Transaction } from '#src/contract.ts';
import type { FetchLike } from '#src/adapters/http.ts';
import type {
  AccrualRow,
  Checkpoint,
  InboxMessage,
  Movement,
  PromoGrant,
  Saga,
  Sale,
  Store,
  Subscription,
  Unit,
} from '#src/ports.ts';

// The two halves of the HTTP store are written apart and shipped together: `http.ts` decides which
// paths it can request, `http-server.ts` decides which it answers. Nothing made them agree except a
// conformance run over whichever paths its cases happened to drive. This file resolves both rosters
// — the client's by driving it and watching the wire, the server's by reading its source — and
// holds them equal. The two readings are deliberately independent: a roster checked against the
// list it was built from passes while examining nothing.

const BASE = 'http://economy.local';

// --- The server's roster, read out of its source -----------------------------------

const SERVER_SOURCE = readFileSync(
  new URL('../../src/adapters/http-server.ts', import.meta.url),
  'utf8',
);

/** One top-level function body, from its declaration to the brace that closes it at column zero. */
function bodyOf(name: string): string {
  const start = SERVER_SOURCE.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `http-server.ts no longer declares ${name}`);
  const end = SERVER_SOURCE.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name} has no closing brace at column zero`);
  return SERVER_SOURCE.slice(start, end);
}

/** Every `<subject> === '<literal>'` arm in one body, in source order. */
function arms(body: string, subject: string): string[] {
  const escaped = subject.replace(/[[\]]/g, '\\$&');
  return [
    ...body.matchAll(new RegExp(`${escaped} === '([A-Za-z]+)'`, 'g')),
  ].map((match) => match[1]!);
}

/** The keys of the `SUBSTORE_ROUTES` table, as `<store>/<method>`. */
function substoreRouteKeys(): string[] {
  const start = SERVER_SOURCE.indexOf('const SUBSTORE_ROUTES');
  assert.notEqual(
    start,
    -1,
    'http-server.ts no longer declares SUBSTORE_ROUTES',
  );
  const end = SERVER_SOURCE.indexOf('\n};\n', start);
  assert.notEqual(end, -1, 'the SUBSTORE_ROUTES table has no closing brace');
  const block = SERVER_SOURCE.slice(start, end);
  return [...block.matchAll(/^ {2}'([a-z]+\/[A-Za-z]+)':/gm)].map(
    (match) => match[1]!,
  );
}

// The first path segment the router branches on, and which function owns the segment after it.
// `tx` is the session router and `close` is a leaf, so neither takes a method table.
const PREFIX_ROUTERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['trust', ['trustRoute']],
  ['checkpoints', ['checkpointRoute']],
  ['movements', ['movementRoute']],
  ['replay', ['replayRoute']],
  ['accruals', ['accrualRoute']],
];

const PREFIXES = arms(bodyOf('dispatch'), 'segments[0]');
const TX_ARMS = arms(bodyOf('txDispatch'), 'tail[0]');
const BEGIN_ARMS = arms(bodyOf('txDispatch'), 'segments[1]');
const LEDGER_METHODS = [
  ...arms(bodyOf('ledgerRoute'), 'method'),
  ...arms(bodyOf('ledgerReadRoute'), 'method'),
];
const SUBSTORE_KEYS = substoreRouteKeys();

/** Every route the server answers, as the path shape a client would have to request. */
function serverRoutes(): string[] {
  const routes = ['/close'];
  for (const arm of BEGIN_ARMS) {
    routes.push(`/tx/${arm}`);
  }
  for (const arm of TX_ARMS) {
    // `ledger` names the sub-router below, not a leaf.
    if (arm !== 'ledger') {
      routes.push(`/tx/:session/${arm}`);
    }
  }
  for (const method of LEDGER_METHODS) {
    routes.push(`/tx/:session/ledger/${method}`);
  }
  for (const key of SUBSTORE_KEYS) {
    routes.push(`/tx/:session/${key}`);
  }
  for (const [prefix, functions] of PREFIX_ROUTERS) {
    for (const name of functions) {
      for (const method of arms(bodyOf(name), 'method')) {
        routes.push(`/${prefix}/${method}`);
      }
    }
  }
  return routes;
}

const SERVER_ROUTES = serverRoutes();

// --- The client's roster, observed on the wire --------------------------------------

type Recorded = { path: string; body: string; ok: boolean };

// Session ids are minted per transaction, so the id collapses to a placeholder: the roster is about
// route shapes. `/tx/begin` has no id to collapse.
function normalize(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'tx' || segments[1] === 'begin') {
    return `/${segments.join('/')}`;
  }
  return `/${['tx', ':session', ...segments.slice(2)].join('/')}`;
}

function recorder(handler: FetchLike, log: Recorded[]): FetchLike {
  return async (request) => {
    const path = normalize(new URL(request.url).pathname);
    const body = await request.clone().text();
    const response = await handler(request);
    const wire = (await response.clone().json()) as { ok: boolean };
    log.push({ path, body, ok: wire.ok });
    return response;
  };
}

// --- Fixtures the drive table calls with -------------------------------------------

const ACCOUNT = 'usr_q76:spendable' as AccountRef;
const TREASURY = 'platform:treasury' as AccountRef;

const TRANSACTION: Transaction = {
  id: 'txn_q76_idem',
  postedAt: 0,
  legs: [],
  links: [],
  meta: {},
};

const SALE: Sale = {
  orderId: 'ord_q76',
  buyerId: 'usr_q76',
  sku: 'sku_q76',
  price: toAmount('CREDIT', 500n),
  fee: toAmount('CREDIT', 50n),
  legs: [],
  txnId: 'txn_q76_sale',
  postedAt: 0,
};

const OUTBOX_ROW: Parameters<Store['outbox']['enqueue']>[0] = {
  id: 'msg_q76',
  event: {
    id: 'evt_q76_outbox',
    type: 'economy.credits.topped_up',
    version: 1,
    occurredAt: 0,
    subject: 'usr_q76',
    data: {},
    audience: 'internal',
  },
  status: 'pending',
  attempts: 0,
  reason: null,
  correlationId: null,
};

const INBOX_ROW: InboxMessage = {
  id: 'ibx_q76',
  key: 'evt_q76_inbox',
  operation: topUp({ userId: 'usr_q76', amount: credit('10.00') }),
  status: 'pending',
  attempts: 0,
  receivedAt: 0,
  reason: null,
};

const SAGA: Saga = {
  id: 'pay_q76',
  userId: 'usr_q76',
  reserve: toAmount('CREDIT', 20_000n),
  rateId: 'rate_q76',
  txnId: 'txn_q76_saga',
  state: 'RESERVED',
  providerRef: null,
  reason: null,
  attempts: 0,
  dueAt: 0,
  updatedAt: 0,
  payoutUsd: null,
};

const SUBSCRIPTION: Subscription = {
  id: 'sub_q76',
  userId: 'usr_q76',
  sellerId: 'sel_q76',
  sku: 'sku_q76',
  price: toAmount('CREDIT', 500n),
  txnId: 'txn_q76_sub',
  periodMs: 86_400_000,
  state: 'ACTIVE',
  period: 0,
  attempts: 0,
  nextDueAt: 1_000,
  updatedAt: 0,
};

const PROMO: PromoGrant = {
  id: 'promo_q76',
  userId: 'usr_q76',
  amount: toAmount('CREDIT', 500n),
  expiresAt: 1_000,
  reversed: false,
};

const ACCRUAL: AccrualRow = {
  orderId: 'ord_q76',
  sellerId: 'sel_q76',
  seq: 0,
  amount: toAmount('CREDIT', 400n),
  shard: SYSTEM.SETTLEMENT_ACCRUAL,
  status: 'pending',
  txnId: 'txn_q76_accrual',
  settledTxnId: null,
  recordedAt: 0,
};

const MOVEMENT: Movement = {
  sessionId: 'sess_q76',
  seq: 0,
  idempotencyKey: 'idem_q76_movement',
  legs: [
    { account: TREASURY, amount: toAmount('CREDIT', -100n) },
    { account: ACCOUNT, amount: toAmount('CREDIT', 100n) },
  ],
  prevHash: '0'.repeat(64),
  hash: 'a'.repeat(64),
  recordedAt: 0,
};

const CHECKPOINT: Checkpoint = {
  id: 'ckpt_q76',
  root: 'b'.repeat(64),
  signature: 'c'.repeat(64),
  count: 1,
  at: 0,
  v: 2,
  sum: '0',
  kid: null,
};

const ATTEMPT = {
  idempotencyKey: 'idem_q76_attempt',
  amount: toAmount('CREDIT', 100n),
  at: 0,
  outcome: 'committed' as const,
};

function posting(txnId: string): Parameters<Store['ledger']['append']>[0] {
  return {
    txnId,
    legs: [
      { account: TREASURY, amount: toAmount('CREDIT', -500n) },
      { account: ACCOUNT, amount: toAmount('CREDIT', 500n) },
    ],
    meta: {},
  };
}

async function drain(source: AsyncIterable<unknown>): Promise<void> {
  for await (const row of source) {
    void row;
  }
}

// --- The drive table ----------------------------------------------------------------

// One entry per method on the client Store, named for the member it drives. The roster below is
// reconciled against the live object's own keys, so a method added to the client with no drive
// here fails rather than going unmeasured.
type Drive = readonly [string, (store: Store) => Promise<void>];

const LEDGER_DRIVES: Drive[] = [
  ['ledger.hasAccount', async (s) => void (await s.ledger.hasAccount(ACCOUNT))],
  ['ledger.lock', async (s) => s.ledger.lock(ACCOUNT)],
  [
    'ledger.append',
    async (s) => void (await s.ledger.append(posting('txn_q76_append'))),
  ],
  ['ledger.balance', async (s) => void (await s.ledger.balance(ACCOUNT))],
  [
    'ledger.posting',
    async (s) => void (await s.ledger.posting('txn_q76_append')),
  ],
  [
    'ledger.statement',
    async (s) => void (await s.ledger.statement(ACCOUNT, { from: 0, to: 1 })),
  ],
  [
    'ledger.derivedBalances',
    async (s) => void (await s.ledger.derivedBalances(ACCOUNT)),
  ],
  ['ledger.timeline', async (s) => drain(s.ledger.timeline(ACCOUNT))],
  ['ledger.heads', async (s) => drain(s.ledger.heads())],
  ['ledger.headSums', async (s) => drain(s.ledger.headSums())],
  ['ledger.balanceAccounts', async (s) => drain(s.ledger.balanceAccounts())],
  ['ledger.lineage', async (s) => drain(s.ledger.lineage(ACCOUNT))],
  ['ledger.links', async (s) => void (await s.ledger.links('txn_q76_append'))],
  ['ledger.linksPage', async (s) => void (await s.ledger.linksPage(null, 10))],
  ['ledger.list', async (s) => drain(s.ledger.list())],
];

const QUEUE_DRIVES: Drive[] = [
  [
    'idempotency.claim',
    async (s) => void (await s.idempotency.claim('idem_q76_a')),
  ],
  [
    'idempotency.record',
    async (s) => s.idempotency.record('idem_q76_b', TRANSACTION),
  ],
  ['sales.put', async (s) => s.sales.put(SALE)],
  ['sales.get', async (s) => void (await s.sales.get(SALE.orderId))],
  ['outbox.enqueue', async (s) => s.outbox.enqueue(OUTBOX_ROW)],
  ['outbox.claimBatch', async (s) => void (await s.outbox.claimBatch(10))],
  [
    'outbox.bumpAttempt',
    async (s) => void (await s.outbox.bumpAttempt('msg_q76')),
  ],
  ['outbox.stats', async (s) => void (await s.outbox.stats())],
  ['outbox.markRelayed', async (s) => s.outbox.markRelayed(['msg_q76'])],
  ['outbox.deadLetter', async (s) => s.outbox.deadLetter('msg_q76', 'Q76')],
  [
    'inbox.enqueueInbound',
    async (s) => void (await s.inbox.enqueueInbound(INBOX_ROW)),
  ],
  [
    'inbox.claimInbound',
    async (s) => void (await s.inbox.claimInbound({ now: 1, limit: 10 })),
  ],
  [
    'inbox.bumpAttempt',
    async (s) => void (await s.inbox.bumpAttempt('ibx_q76')),
  ],
  ['inbox.markApplied', async (s) => s.inbox.markApplied('ibx_q76')],
  ['inbox.deadLetter', async (s) => s.inbox.deadLetter('ibx_q76', 'Q76')],
  ['inbox.reviveDead', async (s) => void (await s.inbox.reviveDead(10))],
];

const SAGA_DRIVES: Drive[] = [
  ['sagas.open', async (s) => s.sagas.open(SAGA)],
  ['sagas.load', async (s) => void (await s.sagas.load(SAGA.id))],
  [
    'sagas.findByProviderRef',
    async (s) => void (await s.sagas.findByProviderRef('ref_q76')),
  ],
  ['sagas.list', async (s) => drain(s.sagas.list())],
  ['sagas.claimDue', async (s) => void (await s.sagas.claimDue(1, 10))],
  [
    'sagas.advance',
    async (s) =>
      void (await s.sagas.advance(SAGA.id, 'RESERVED', 'SUBMITTED', {
        providerRef: 'ref_q76',
      })),
  ],
  ['sagas.deadLetter', async (s) => s.sagas.deadLetter(SAGA.id, 'Q76')],
  [
    'sagas.lastPayoutAt',
    async (s) => void (await s.sagas.lastPayoutAt('usr_q76')),
  ],
  ['subscriptions.open', async (s) => s.subscriptions.open(SUBSCRIPTION)],
  [
    'subscriptions.load',
    async (s) => void (await s.subscriptions.load(SUBSCRIPTION.id)),
  ],
  [
    'subscriptions.activeFor',
    async (s) =>
      void (await s.subscriptions.activeFor('usr_q76', 'sku_q76', 'sel_q76')),
  ],
  [
    'subscriptions.listFor',
    async (s) => drain(s.subscriptions.listFor('usr_q76')),
  ],
  [
    'subscriptions.claimDue',
    async (s) => void (await s.subscriptions.claimDue(1, 10)),
  ],
  [
    'subscriptions.markBilled',
    async (s) =>
      void (await s.subscriptions.markBilled(SUBSCRIPTION.id, 2_000, 1_000)),
  ],
  [
    'subscriptions.markLapsed',
    async (s) => s.subscriptions.markLapsed(SUBSCRIPTION.id),
  ],
  [
    'subscriptions.cancel',
    async (s) => s.subscriptions.cancel(SUBSCRIPTION.id),
  ],
  ['promos.open', async (s) => s.promos.open(PROMO)],
  ['promos.liveFor', async (s) => void (await s.promos.liveFor('usr_q76'))],
  ['promos.holders', async (s) => drain(s.promos.holders())],
  ['promos.claimDue', async (s) => void (await s.promos.claimDue(1, 10))],
  ['promos.markReversed', async (s) => s.promos.markReversed(PROMO.id)],
  [
    'entitlements.grant',
    async (s) => s.entitlements.grant('usr_q76', 'sku_q76', { quantity: 1 }),
  ],
  [
    'entitlements.owns',
    async (s) => void (await s.entitlements.owns('usr_q76', 'sku_q76')),
  ],
  ['entitlements.list', async (s) => drain(s.entitlements.list('usr_q76'))],
  [
    'entitlements.revoke',
    async (s) => s.entitlements.revoke('usr_q76', 'sku_q76'),
  ],
];

// The accrual write methods on the root store refuse before they reach the wire, which is why the
// drive below asserts the refusal instead of a path. The same methods over a transaction unit do
// send, on their own prefix — that pair is what `UNIT_DRIVES` covers.
const ROOT_ONLY_DRIVES: Drive[] = [
  ['trust.read', async (s) => void (await s.trust.read('usr_q76'))],
  ['trust.bump', async (s) => s.trust.bump('usr_q76', ATTEMPT)],
  [
    'trust.record',
    async (s) => void (await s.trust.record('usr_q76', ATTEMPT)),
  ],
  ['checkpoints.put', async (s) => s.checkpoints.put(CHECKPOINT)],
  ['checkpoints.latest', async (s) => void (await s.checkpoints.latest())],
  ['checkpoints.reproof', async (s) => void (await s.checkpoints.reproof!())],
  [
    'checkpoints.putReproof',
    async (s) => s.checkpoints.putReproof!({ cursor: null, rotatedAt: null }),
  ],
  ['movements.append', async (s) => s.movements.append([MOVEMENT])],
  [
    'movements.bySession',
    async (s) => drain(s.movements.bySession('sess_q76')),
  ],
  ['replay.claim', async (s) => void (await s.replay.claim('evt_q76_replay'))],
  [
    'accruals.pendingSellers',
    async (s) => void (await s.accruals.pendingSellers(10)),
  ],
  ['accruals.stats', async (s) => void (await s.accruals.stats())],
  [
    'accruals.netPending',
    async (s) => void (await s.accruals.netPending('sel_q76')),
  ],
];

const REFUSAL = /accrual writes must run inside store\.transaction/;

const REFUSED_DRIVES: Drive[] = [
  [
    'accruals.put',
    async (s) => assert.rejects(s.accruals.put([ACCRUAL]), REFUSAL),
  ],
  [
    'accruals.claimByOrder',
    async (s) => assert.rejects(s.accruals.claimByOrder('ord_q76'), REFUSAL),
  ],
  [
    'accruals.claimPendingBySeller',
    async (s) =>
      assert.rejects(s.accruals.claimPendingBySeller('sel_q76', 10), REFUSAL),
  ],
  [
    'accruals.markDrained',
    async (s) => assert.rejects(s.accruals.markDrained([], 'txn_q76'), REFUSAL),
  ],
  [
    'accruals.markRefunded',
    async (s) =>
      assert.rejects(s.accruals.markRefunded([], 'txn_q76'), REFUSAL),
  ],
];

const LIFECYCLE_DRIVES: Drive[] = [
  [
    'transaction',
    async (s) => {
      await s.transaction(async () => {});
      await assert.rejects(
        s.transaction(async () => {
          throw new Error('q76 rollback');
        }),
      );
    },
  ],
  ['close', async (s) => s.close()],
];

// `close` shuts the backing store, so it runs last.
const ROOT_DRIVES: Drive[] = [
  ...LEDGER_DRIVES,
  ...QUEUE_DRIVES,
  ...SAGA_DRIVES,
  ...ROOT_ONLY_DRIVES,
  ...REFUSED_DRIVES,
  ...LIFECYCLE_DRIVES,
];

const UNIT_DRIVES: ReadonlyArray<
  readonly [string, (unit: Unit) => Promise<void>]
> = [
  ['accruals.put', async (u) => u.accruals.put([ACCRUAL])],
  [
    'accruals.claimByOrder',
    async (u) => void (await u.accruals.claimByOrder('ord_q76')),
  ],
  [
    'accruals.pendingSellers',
    async (u) => void (await u.accruals.pendingSellers(10)),
  ],
  [
    'accruals.claimPendingBySeller',
    async (u) => void (await u.accruals.claimPendingBySeller('sel_q76', 10)),
  ],
  [
    'accruals.markDrained',
    async (u) => u.accruals.markDrained([], 'txn_q76_drain'),
  ],
  [
    'accruals.markRefunded',
    async (u) => u.accruals.markRefunded([], 'txn_q76_refund'),
  ],
  ['accruals.stats', async (u) => void (await u.accruals.stats())],
  [
    'accruals.netPending',
    async (u) => void (await u.accruals.netPending('sel_q76')),
  ],
];

// --- Driving the client -------------------------------------------------------------

type Observed = {
  log: Recorded[];
  perLabel: Map<string, Recorded[]>;
  unitKeys: Record<string, string[]>;
  failures: string[];
};

async function observeClient(): Promise<Observed> {
  const log: Recorded[] = [];
  const backing = memoryStore();
  const store = httpStore({
    fetch: recorder(createStoreServer(backing), log),
  });
  const perLabel = new Map<string, Recorded[]>();
  const failures: string[] = [];
  let unitKeys: Record<string, string[]> = {};

  // A drive that throws is collected, not propagated. A route the server no longer answers makes
  // its client call throw, and that has to surface as the named assertion below rather than as a
  // module-level crash before the first test registers.
  const run = async (
    label: string,
    drive: () => Promise<void>,
  ): Promise<void> => {
    const before = log.length;
    try {
      await drive();
    } catch (error) {
      failures.push(`${label}: ${String(error)}`);
    }
    perLabel.set(label, log.slice(before));
  };

  try {
    await store.transaction(async (unit) => {
      unitKeys = memberKeys(unit as unknown as Record<string, unknown>);
      for (const [label, drive] of UNIT_DRIVES) {
        await run(`unit.${label}`, () => drive(unit));
      }
    });
  } catch (error) {
    failures.push(`unit transaction: ${String(error)}`);
  }

  for (const [label, drive] of ROOT_DRIVES) {
    await run(`store.${label}`, () => drive(store));
  }

  return { log, perLabel, unitKeys, failures };
}

/** The callable members of each port on a store or unit, as `<port>.<method>` groups. */
function memberKeys(
  subject: Record<string, unknown>,
): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(subject)) {
    if (typeof value === 'function') {
      groups[key] = [];
      continue;
    }
    const port = value as Record<string, unknown>;
    groups[key] = Object.keys(port).filter(
      (member) => typeof port[member] === 'function',
    );
  }
  return groups;
}

function labelsOf(groups: Record<string, string[]>, prefix: string): string[] {
  return Object.entries(groups).flatMap(([port, members]) =>
    members.length === 0
      ? [`${prefix}.${port}`]
      : members.map((member) => `${prefix}.${port}.${member}`),
  );
}

const OBSERVED = await observeClient();
const CLIENT_PATHS = [...new Set(OBSERVED.log.map((row) => row.path))];

// --- The rosters --------------------------------------------------------------------

describe('http store route roster', () => {
  test('every drive of the client surface ran to completion', () => {
    // First, because a route the server stopped answering makes its client call throw, and the
    // label names which member of the surface lost its route.
    assert.deepEqual(OBSERVED.failures, []);
  });

  test('the server source resolves the route table it is read for', () => {
    // Each count is exact. An extractor that quietly stopped matching leaves every set difference
    // below empty, which is the shape that passes while examining nothing.
    assert.deepEqual([...PREFIXES].sort(), [
      'accruals',
      'checkpoints',
      'close',
      'movements',
      'replay',
      'trust',
      'tx',
    ]);
    assert.deepEqual(
      [...PREFIXES].sort(),
      ['tx', 'close', ...PREFIX_ROUTERS.map(([prefix]) => prefix)].sort(),
      'a top-level prefix is routed with no method table naming its routes',
    );
    assert.deepEqual(BEGIN_ARMS, ['begin']);
    assert.deepEqual(TX_ARMS, ['commit', 'rollback', 'ledger']);
    assert.equal(LEDGER_METHODS.length, 15);
    assert.equal(SUBSTORE_KEYS.length, 49);
    assert.equal(
      new Set(SUBSTORE_KEYS).size,
      49,
      'a route key is declared twice',
    );
    assert.equal(SERVER_ROUTES.length, 81);
    assert.equal(
      new Set(SERVER_ROUTES).size,
      81,
      'a route is reachable two ways',
    );
  });

  test('the drive table names every member of the client store and unit', () => {
    // The drive table is the only way a client path gets observed, so a member with no drive is a
    // path this file never sees. The roster comes off the live object, never off the table.
    const store = httpStore();
    const expected = [
      ...labelsOf(
        memberKeys(store as unknown as Record<string, unknown>),
        'store',
      ),
      ...(OBSERVED.unitKeys.accruals ?? []).map(
        (member) => `unit.accruals.${member}`,
      ),
    ];
    assert.deepEqual([...OBSERVED.perLabel.keys()].sort(), expected.sort());
    assert.equal(expected.length, 84);
  });

  test('every port the transaction unit shares with the store has the same members', () => {
    // Driving at the root covers the session prefix for these, because they are the same factories
    // over a different session id. `accruals` is the deliberate exception: the root store swaps in
    // a different implementation on a different prefix, so it is driven on both sides.
    const store = httpStore();
    const rootKeys = memberKeys(store as unknown as Record<string, unknown>);
    for (const [port, members] of Object.entries(OBSERVED.unitKeys)) {
      assert.deepEqual(
        [...members].sort(),
        [...rootKeys[port]!].sort(),
        `${port} differs between the store and the transaction unit`,
      );
    }
    assert.equal(Object.keys(OBSERVED.unitKeys).length, 11);
  });

  test('every client path is a route the server declares, and the reverse', () => {
    const client = new Set(CLIENT_PATHS);
    const server = new Set(SERVER_ROUTES);
    assert.deepEqual(
      [...client].filter((path) => !server.has(path)).sort(),
      [],
      'the client can request a path no server route answers',
    );
    assert.deepEqual(
      [...server].filter((route) => !client.has(route)).sort(),
      [],
      'the server answers a route no client path reaches',
    );
    assert.equal(client.size, 81);
    assert.equal(server.size, 81);
  });

  test('every drive but the in-transaction-only refusals put a request on the wire', () => {
    const refused = new Set(REFUSED_DRIVES.map(([label]) => `store.${label}`));
    let observed = 0;
    for (const [label, rows] of OBSERVED.perLabel) {
      if (refused.has(label)) {
        assert.deepEqual(
          rows,
          [],
          `${label} reached the wire, so the root refusal is gone`,
        );
        continue;
      }
      assert.notEqual(rows.length, 0, `${label} sent no request`);
      observed += 1;
    }
    assert.equal(refused.size, 5);
    assert.equal(observed, 79);
  });

  test('every request the client sent was answered', () => {
    // An unknown route is a throw, and a throw normalizes to `ok: false` on the wire. So `ok` is
    // the only signal that separates a route from a gap, and it is the signal the control below
    // proves can go the other way.
    const refused = OBSERVED.log.filter((row) => !row.ok);
    assert.deepEqual(
      refused.map((row) => row.path),
      [],
    );
    assert.equal(OBSERVED.log.length, 84);
  });
});

// --- The control: each route is resolved by its name, not by a fallthrough ----------

type Answer = {
  ok: boolean;
  body?: unknown;
  error?: { code: string; message: string; retryable: boolean };
};

async function send(path: string, body: string): Promise<Answer> {
  const backing = memoryStore();
  const handler = createStoreServer(backing);
  const post = async (target: string): Promise<Answer> => {
    const response = await handler(
      new Request(new URL(target, BASE), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    return (await response.json()) as Answer;
  };
  try {
    if (!path.startsWith('/tx/:session/')) {
      return await post(path);
    }
    // commit and rollback need a session this server minted; every other session path resolves
    // 'root', which the router maps to the backing store.
    const tail = path.slice('/tx/:session/'.length);
    if (tail !== 'commit' && tail !== 'rollback') {
      return await post(`/tx/root/${tail}`);
    }
    const begun = await post('/tx/begin');
    const session = (begun.body as { session: string }).session;
    return await post(`/tx/${session}/${tail}`);
  } finally {
    await backing.close();
  }
}

/** The same path with one character appended to its last segment. */
const MISSING = 'Q76Missing';

function misnamed(path: string): string {
  return `${path}${MISSING}`;
}

describe('http store route resolution', () => {
  // One (path, body) pair per route, taken from the request the client actually sent.
  const requests = new Map<string, string>();
  for (const row of OBSERVED.log) {
    if (!requests.has(row.path)) {
      requests.set(row.path, row.body);
    }
  }

  test('every route answers the body its client sends', async () => {
    let answered = 0;
    for (const [path, body] of requests) {
      assert.equal(
        (await send(path, body)).ok,
        true,
        `${path} refused its own body`,
      );
      answered += 1;
    }
    assert.equal(answered, 81);
  });

  test('the same body under a misspelled route name is refused', async () => {
    // The positive control. Without it, `answered` above passes on a router that resolves anything
    // — which is exactly what a trailing fallthrough arm does: it runs the last handler in the
    // chain for every name it does not recognize, so a client renamed on one side gets a plausible
    // answer from the wrong route rather than a failure.
    const resolved: string[] = [];
    for (const [path, body] of requests) {
      if ((await send(misnamed(path), body)).ok) {
        resolved.push(misnamed(path));
      }
    }
    assert.deepEqual(resolved, [], 'a route that does not exist answered');
    assert.equal(requests.size, 81);
  });

  test('every refusal is permanent and names the name that failed', async () => {
    // Refusing is half the job. A refusal that reaches the caller as a retryable STORE.FAILURE
    // with the route stripped out of the message is a permanent failure wearing a transient
    // failure's clothes, and a caller that retries on `retryable` retries a name that will never
    // exist. Each miss is classified here, and the split is exact: a classifier that stopped
    // classifying moves one of these two counts.
    const byCode = new Map<string, string[]>();
    for (const [path, body] of requests) {
      const answer = await send(misnamed(path), body);
      const error = answer.error;
      assert.ok(error, `${misnamed(path)} came back with no error payload`);
      assert.equal(
        error.retryable,
        false,
        `${misnamed(path)} is permanent but was reported retryable`,
      );
      assert.ok(
        error.message.includes(MISSING),
        `${misnamed(path)} was refused as "${error.message}", which does not name it`,
      );
      byCode.set(error.code, [...(byCode.get(error.code) ?? []), path]);
    }

    // `/tx/begin` misnamed is not a route miss: `txDispatch` reads the segment after `tx` as a
    // session id once it is not `begin`, so the server is asked for a transaction it never minted.
    assert.deepEqual(byCode.get(ERROR_CODES.UNKNOWN_SESSION), ['/tx/begin']);
    assert.equal(byCode.get(ERROR_CODES.UNKNOWN_ROUTE)?.length, 80);
    assert.deepEqual([...byCode.keys()].sort(), [
      ERROR_CODES.UNKNOWN_ROUTE,
      ERROR_CODES.UNKNOWN_SESSION,
    ]);
  });

  test('an unknown top-level prefix is refused the same way', async () => {
    // The 81 above all reach a router. This is the throw before any of them, and it is what a
    // stale or hostile client hits first.
    const answer = await send('/nowhere/at/all', '{}');
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.code, ERROR_CODES.UNKNOWN_ROUTE);
    assert.equal(answer.error?.retryable, false);
    assert.equal(answer.error?.message, 'unknown path /nowhere/at/all');
  });

  test('a transaction the server is not holding is refused, not retried', async () => {
    // Reachable without any client bug: the session map is per-process, so a restart or a second
    // instance behind a load balancer loses every id it minted, and a settled id is gone by
    // design. Before this, each of these threw a bare TypeError on the `!` and reached the caller
    // as a retryable STORE.FAILURE.
    for (const path of [
      '/tx/sess_gone/ledger/balance',
      '/tx/sess_gone/commit',
      '/tx/sess_gone/rollback',
    ]) {
      const answer = await send(path, '{}');
      assert.equal(answer.ok, false, `${path} answered`);
      assert.equal(answer.error?.code, ERROR_CODES.UNKNOWN_SESSION, path);
      assert.equal(answer.error?.retryable, false, path);
      assert.equal(
        answer.error?.message,
        'unknown transaction sess_gone',
        path,
      );
    }
  });
});
