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

/**
 * The /v1 read family under principal scoping: a user token reads only itself.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '#src/server.ts';
import type { FetchHandler, ServerOptions } from '#src/server.ts';
import { WIRE_LIST_KEY, wireRowIdentity } from '#src/client.ts';
import type { WireListName } from '#src/client.ts';
import { economyWithStore, makeEconomy } from '#test/support/economy.ts';
import type { Saga, Store, Subscription } from '#src/ports.ts';
import {
  fixedClock,
  fixedRates,
  silentMeter,
  testConfig,
  testLogger,
  testSecrets,
} from '#test/support/capabilities.ts';
import { topUp, spend, requestPayout, idempotencyKey } from '#src/operation.ts';
import { credits } from '#src/money.ts';
import { systemActor, userActor } from '#src/actor.ts';
import type { Economy, Principal } from '#src/contract.ts';

const tokens: Record<string, Principal> = {
  ada: { kind: 'user', userId: 'usr_ada' },
  ben: { kind: 'user', userId: 'usr_ben' },
  ops: { kind: 'operator', operatorId: 'op_1' },
};

async function seededServer(
  overrides: Partial<ServerOptions> = {},
): Promise<{ handler: FetchHandler; economy: Economy; txnId: string }> {
  const clock = fixedClock(50_000_000);
  const economy = makeEconomy(7);
  const key = (n: string) => idempotencyKey('reads', n);
  await economy.submit(
    topUp({
      idempotencyKey: key('1'),
      actor: systemActor('t'),
      userId: 'usr_ada',
      amount: credits(500),
      source: 'card',
    }),
  );
  const sale = await economy.submit(
    spend({
      idempotencyKey: key('2'),
      actor: userActor('usr_ada'),
      orderId: 'ord_r1',
      buyerId: 'usr_ada',
      sku: 'kit',
      price: credits(100),
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    }),
  );
  await economy
    .submit(
      requestPayout({
        idempotencyKey: key('3'),
        actor: userActor('usr_ben'),
        userId: 'usr_ben',
        amount: credits(50),
      }),
    )
    .catch(() => null);
  const handler = createServer({
    economy,
    ports: {
      config: testConfig(),
      secrets: testSecrets(),
      clock,
      meter: silentMeter(),
      logger: testLogger(),
      rates: fixedRates(),
    },
    authenticate: async (request) =>
      tokens[
        request.headers.get('authorization')?.replace('Bearer ', '') ?? ''
      ] ?? null,
    ...overrides,
  });
  const txnId = (sale as { transaction: { id: string } }).transaction.id;
  return { handler, economy, txnId };
}

const get = async (handler: FetchHandler, path: string, token?: string) => {
  const response = await handler(
    new Request(`http://t${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as never,
  };
};

describe('The /v1 Read Family', () => {
  test('wallet: own scope, zeros never 404, payableNow rides along', async () => {
    const { handler } = await seededServer();
    const mine = await get(handler, '/v1/wallet', 'ada');
    assert.equal(mine.status, 200);
    assert.equal(
      (mine.body as { spendable: string }).spendable,
      'CREDIT:400.00',
    );
    assert.ok('payableNow' in (mine.body as object));

    const ghost = await get(handler, '/v1/wallet?userId=usr_nobody', 'ops');
    assert.equal(
      ghost.status,
      200,
      'a never-seen user reads as zeros, not 404',
    );
    assert.equal(
      (ghost.body as { spendable: string }).spendable,
      'CREDIT:0.00',
    );

    const foreign = await get(handler, '/v1/wallet?userId=usr_ben', 'ada');
    assert.equal(foreign.status, 401, 'a user token reads only itself');

    const anon = await get(handler, '/v1/wallet');
    assert.equal(anon.status, 401);
  });

  test('lists: envelope with an end-of-list null cursor, limit clamp, state filter', async () => {
    const { handler } = await seededServer();
    const payouts = await get(handler, '/v1/payouts?userId=usr_ben', 'ops');
    assert.equal(payouts.status, 200);
    const envelope = payouts.body as {
      items: { userId: string }[];
      cursor: string | null;
    };
    assert.equal(envelope.cursor, null, 'one page holds the whole list');
    assert.equal(envelope.items.length, 1);
    assert.ok(envelope.items.every((saga) => saga.userId === 'usr_ben'));

    // A bad limit collapses to the default page (the item still shows) and an oversized
    // ask caps at the ceiling — never a 400.
    const zero = await get(handler, '/v1/entitlements?limit=0', 'ada');
    assert.equal(zero.status, 200);
    assert.equal((zero.body as { items: unknown[] }).items.length, 1);
    assert.equal(
      (await get(handler, '/v1/entitlements?limit=banana', 'ada')).status,
      200,
    );
    assert.equal(
      (await get(handler, '/v1/payouts?userId=usr_ben&limit=10000', 'ops'))
        .status,
      200,
    );

    // ?state= narrows for real; an unknown state answers 400 rather than an empty page.
    const reserved = await get(
      handler,
      '/v1/payouts?userId=usr_ben&state=RESERVED',
      'ops',
    );
    assert.equal((reserved.body as { items: unknown[] }).items.length, 1);
    const settledOnly = await get(
      handler,
      '/v1/payouts?userId=usr_ben&state=SETTLED',
      'ops',
    );
    assert.equal((settledOnly.body as { items: unknown[] }).items.length, 0);
    assert.equal(
      (await get(handler, '/v1/payouts?userId=usr_ben&state=BOGUS', 'ops'))
        .status,
      400,
    );
    assert.equal(
      (await get(handler, '/v1/subscriptions?state=SETTLED', 'ada')).status,
      400,
      'a saga state is not a subscription state',
    );

    assert.equal((await get(handler, '/v1/subscriptions', 'ada')).status, 200);
    assert.equal((await get(handler, '/v1/entitlements', 'ada')).status, 200);
  });

  test('rates and catalog answer without a subject', async () => {
    const { handler } = await seededServer();
    const rates = await get(handler, '/v1/rates', 'ada');
    assert.equal(rates.status, 200);
    assert.ok((rates.body as { payout: { rateId: string } }).payout.rateId);
    const catalog = await get(handler, '/v1/catalog', 'ada');
    assert.equal(catalog.status, 200);
    assert.ok(Array.isArray((catalog.body as { bundles: unknown[] }).bundles));
  });

  test('posting: own-if-touched — a stranger reads 404, a participant reads the legs', async () => {
    const { handler, txnId } = await seededServer();
    assert.equal(
      (await get(handler, `/v1/posting/${txnId}`, 'ada')).status,
      200,
    );
    assert.equal(
      (await get(handler, `/v1/posting/${txnId}`, 'ben')).status,
      200,
      'the seller was touched too',
    );
    const ghost = {
      ...tokens,
      ada: { kind: 'user', userId: 'usr_ghost' } as Principal,
    };
    tokens.ghost = ghost.ada;
    assert.equal(
      (await get(handler, `/v1/posting/${txnId}`, 'ghost')).status,
      404,
      'a foreign transaction reads as absent',
    );
    assert.equal(
      (await get(handler, `/v1/posting/${txnId}`, 'ops')).status,
      200,
    );
  });

  test('reads: false unmounts the family; the writes stay', async () => {
    const { handler } = await seededServer({ reads: false });
    assert.equal((await get(handler, '/v1/wallet', 'ada')).status, 404);
  });

  test('reads echo x-request-id and answer 429 through a denying limiter', async () => {
    const { handler } = await seededServer();
    const echoed = await handler(
      new Request('http://t/v1/rates', {
        headers: { authorization: 'Bearer ada', 'x-request-id': 'req_reads_9' },
      }),
    );
    assert.equal(echoed.headers.get('x-request-id'), 'req_reads_9');

    const { handler: limited } = await seededServer({
      rateLimit: {
        limiter: {
          allow: async () => ({ allowed: false, retryAfterMs: 2_000 }),
        },
      },
    });
    const denied = await limited(
      new Request('http://t/v1/wallet', {
        headers: { authorization: 'Bearer ada' },
      }),
    );
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get('retry-after'), '2');
  });
});

// --- The resume cursor --------------------------------------------------------------

type Page = { items: Record<string, unknown>[]; cursor: string | null };

// Rows are written straight to the store. These reads are store delegations, so a seeded row
// reads exactly like an operated one, and a few hundred of them cost no postings.
async function storeServer(
  seed: (store: Store) => Promise<void>,
): Promise<FetchHandler> {
  const { economy, store } = economyWithStore(9);
  await seed(store);
  return createServer({
    economy,
    ports: {
      config: testConfig(),
      secrets: testSecrets(),
      clock: fixedClock(50_000_000),
      meter: silentMeter(),
      logger: testLogger(),
      rates: fixedRates(),
    },
    authenticate: async (request) =>
      tokens[
        request.headers.get('authorization')?.replace('Bearer ', '') ?? ''
      ] ?? null,
  });
}

const saga = (id: string, userId: string, updatedAt: number): Saga => ({
  id,
  userId,
  reserve: credits(50),
  rateId: 'rate_test',
  txnId: `txn_${id}`,
  state: 'RESERVED',
  providerRef: null,
  reason: null,
  attempts: 0,
  dueAt: updatedAt,
  updatedAt,
  payoutUsd: null,
});

const subscription = (
  id: string,
  userId: string,
  updatedAt: number,
): Subscription => ({
  id,
  userId,
  sellerId: 'usr_ben',
  sku: `sku_${id}`,
  price: credits(5),
  txnId: `txn_${id}`,
  periodMs: 86_400_000,
  state: 'ACTIVE',
  period: 1,
  attempts: 0,
  nextDueAt: updatedAt + 86_400_000,
  updatedAt,
});

// Follows the cursor to the end of a list and returns every row it saw, plus the page count.
async function walk(
  handler: FetchHandler,
  path: string,
  token: string,
): Promise<{ rows: Record<string, unknown>[]; pages: number }> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const step: string =
      cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const page = await get(handler, `${path}${step}`, token);
    assert.equal(page.status, 200, `${path} page ${pages + 1}`);
    const body = page.body as Page;
    rows.push(...body.items);
    pages += 1;
    cursor = body.cursor;
    if (cursor === null || pages > 50) {
      break;
    }
  }
  return { rows, pages };
}

describe('The /v1 Resume Cursor', () => {
  test('walks a list past the 200-item read ceiling, every row exactly once', async () => {
    const skus = Array.from(
      { length: 250 },
      (_, i) => `pass-${String(i + 1).padStart(3, '0')}`,
    );
    const handler = await storeServer(async (store) => {
      await store.transaction(async (unit) => {
        for (const sku of skus) {
          await unit.entitlements.grant('usr_ada', sku, {});
        }
      });
    });

    const capped = await get(handler, '/v1/entitlements?limit=10000', 'ada');
    const first = capped.body as Page;
    assert.equal(
      first.items.length,
      200,
      'one read still stops at the ceiling',
    );
    assert.notEqual(
      first.cursor,
      null,
      'a page the ceiling cut short says so with a cursor',
    );

    const walked = await walk(handler, '/v1/entitlements?limit=100', 'ada');
    assert.equal(walked.pages, 3, '250 rows over a 100-row page');
    assert.deepEqual(
      walked.rows.map((row) => row.sku),
      skus,
      'every seeded sku, in order, no gap and no repeat',
    );
  });

  test('a cursor never carries scope: replayed on another caller it reads only that caller', async () => {
    const handler = await storeServer(async (store) => {
      await store.transaction(async (unit) => {
        for (let i = 1; i <= 6; i += 1) {
          await unit.sagas.open(
            saga(`pay_ada_${i}`, 'usr_ada', 10_000 - i * 1000),
          );
        }
        await unit.sagas.open(saga('pay_ben_1', 'usr_ben', 3_000));
        await unit.sagas.open(saga('pay_ben_2', 'usr_ben', 2_000));
      });
    });

    const mine = await get(handler, '/v1/payouts?limit=2', 'ada');
    const page = mine.body as Page;
    assert.deepEqual(
      page.items.map((row) => row.id),
      ['pay_ada_1', 'pay_ada_2'],
      'ada reads her own newest two',
    );
    const stolen = page.cursor!;
    assert.notEqual(stolen, null);

    // Ben's rows sit below ada's cursor in the same order, so they survive the resume: an
    // empty page would prove nothing.
    const replayed = await get(
      handler,
      `/v1/payouts?limit=10&cursor=${encodeURIComponent(stolen)}`,
      'ben',
    );
    assert.equal(replayed.status, 200);
    const seen = (replayed.body as Page).items;
    assert.deepEqual(
      seen.map((row) => row.id),
      ['pay_ben_1', 'pay_ben_2'],
      "ada's cursor positions ben's own walk and nothing more",
    );
    assert.ok(
      seen.every((row) => row.userId === 'usr_ben'),
      'not one row of another user',
    );

    // A hand-built token naming a user is still only a position: the scope is the bearer's.
    const forged = btoa(
      JSON.stringify({
        k: 'payouts',
        t: 9_000,
        i: 'pay_ada_1',
        userId: 'usr_ada',
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const injected = await get(
      handler,
      `/v1/payouts?limit=10&cursor=${encodeURIComponent(forged)}`,
      'ben',
    );
    assert.equal(injected.status, 200);
    assert.ok(
      (injected.body as Page).items.every((row) => row.userId === 'usr_ben'),
      'a forged cursor cannot name a subject',
    );
  });

  test('rows sharing a timestamp page without a skip or a repeat', async () => {
    const ids = ['pay_e', 'pay_a', 'pay_d', 'pay_b', 'pay_c'];
    const handler = await storeServer(async (store) => {
      await store.transaction(async (unit) => {
        for (const id of ids) {
          await unit.sagas.open(saga(id, 'usr_ada', 7_000));
        }
        for (const id of ids) {
          await unit.subscriptions.open(
            subscription(`sub${id.slice(3)}`, 'usr_ada', 7_000),
          );
        }
      });
    });

    const payouts = await walk(handler, '/v1/payouts?limit=1', 'ada');
    assert.equal(payouts.pages, 5, 'one row a page, five pages, then the end');
    assert.deepEqual(
      payouts.rows.map((row) => row.id),
      [...ids].sort().reverse(),
      'the id tiebreak orders a five-way timestamp tie, descending',
    );

    const subs = await walk(
      handler,
      '/v1/subscriptions?limit=2&state=ACTIVE',
      'ada',
    );
    assert.equal(
      new Set(subs.rows.map((row) => row.id)).size,
      5,
      'the filtered walk sees five distinct rows',
    );
    assert.equal(subs.rows.length, 5, 'and repeats none of them');
  });

  test('no cursor reads what it always read, and the token never shows a column', async () => {
    const handler = await storeServer(async (store) => {
      await store.transaction(async (unit) => {
        for (let i = 1; i <= 3; i += 1) {
          await unit.sagas.open(saga(`pay_ada_${i}`, 'usr_ada', 5_000 + i));
        }
      });
    });

    const legacy = await get(handler, '/v1/payouts?limit=2', 'ada');
    assert.equal(legacy.status, 200);
    const page = legacy.body as Page;
    assert.deepEqual(
      page.items.map((row) => row.id),
      ['pay_ada_3', 'pay_ada_2'],
      'an absent cursor is the newest-first head of the list, exactly as before',
    );

    const whole = await get(handler, '/v1/payouts', 'ada');
    assert.equal(
      (whole.body as Page).cursor,
      null,
      'a list that fits in the default page ends there',
    );

    // A caller that spells "no cursor yet" as an empty one gets page one, not a 400 on its
    // very first read.
    const empty = await get(handler, '/v1/payouts?limit=2&cursor=', 'ada');
    assert.equal(empty.status, 200);
    assert.deepEqual(
      (empty.body as Page).items.map((row) => row.id),
      ['pay_ada_3', 'pay_ada_2'],
      'an empty cursor reads as an absent one',
    );

    assert.ok(
      !page.cursor!.includes('pay_ada_2'),
      'the token is not the row id',
    );
    assert.match(page.cursor!, /^[\w-]+$/, 'and rides a URL without escaping');
  });

  test('a malformed or foreign cursor answers 400, never a silent restart', async () => {
    const handler = await storeServer(async (store) => {
      await store.transaction(async (unit) => {
        await unit.sagas.open(saga('pay_ada_1', 'usr_ada', 5_000));
        await unit.sagas.open(saga('pay_ada_2', 'usr_ada', 4_000));
        await unit.entitlements.grant('usr_ada', 'pass-1', {});
        await unit.entitlements.grant('usr_ada', 'pass-2', {});
      });
    });

    assert.equal(
      (await get(handler, '/v1/payouts?cursor=not-a-token', 'ada')).status,
      400,
    );
    const payouts = await get(handler, '/v1/payouts?limit=1', 'ada');
    const foreign = (payouts.body as Page).cursor!;
    assert.equal(
      (
        await get(
          handler,
          `/v1/entitlements?limit=1&cursor=${encodeURIComponent(foreign)}`,
          'ada',
        )
      ).status,
      400,
      "one list's cursor is not another's",
    );
  });

  /**
   * The exported row identity is the field the server's own cursor resumes on.
   *
   * `WIRE_LIST_KEY` is what the route reads to decide how to order and resume each list, and it
   * is exported so a consumer merging two reads of one list keys on the same field rather than
   * guessing from a row's shape. This drives the export against the cursor the route actually
   * mints: the field named for the list has to be the field inside the decoded token, and the
   * identity of the last row on a page has to be built from it. A guess would pass on payouts
   * and fail here on entitlements, which is the row that carries both fields.
   */
  test('the exported row identity keys on the field the cursor resumes on', async () => {
    const handler = await storeServer(async (store) => {
      await store.transaction(async (unit) => {
        for (let i = 1; i <= 3; i += 1) {
          await unit.sagas.open(saga(`pay_ada_${i}`, 'usr_ada', 5_000 + i));
          await unit.subscriptions.open(
            subscription(`sub_ada_${i}`, 'usr_ada', 5_000 + i),
          );
          await unit.entitlements.grant('usr_ada', `pass-${i}`, {});
        }
      });
    });

    let examined = 0;
    for (const list of Object.keys(WIRE_LIST_KEY) as WireListName[]) {
      const page = (await get(handler, `/v1/${list}?limit=2`, 'ada'))
        .body as Page;
      assert.equal(page.items.length, 2, `${list} answered a two-row page`);

      // The token is opaque on the wire and readable here, which is the only place it is.
      const resume = JSON.parse(
        Buffer.from(page.cursor!, 'base64url').toString('utf8'),
      ) as { k: string; s?: string; i?: string };
      assert.equal(resume.k, list);

      const last = page.items[1]!;
      const field = WIRE_LIST_KEY[list];
      assert.equal(
        resume[field === 'sku' ? 's' : 'i'],
        last[field],
        `${list} resumes on its ${field}, so that is what identifies its rows`,
      );
      assert.equal(
        wireRowIdentity(list, last),
        `${field}\0${String(last[field])}`,
        `${list} rows are identified by ${field}`,
      );
      examined += 1;
    }
    assert.equal(examined, 3, 'all three lists read, resumed and identified');

    // The wire's rows today: an entitlement carries no id at all, and a subscription carries
    // both fields. So a structural rule reading `id ?? sku` off a row happens to agree with the
    // table on all three lists, and the two answers separate only on a row shape the wire does
    // not currently mint. Stated because it is the difference between "the copy was wrong" and
    // "the copy was a second statement of a rule that had not diverged yet".
    const grant = (await get(handler, '/v1/entitlements?limit=1', 'ada'))
      .body as Page;
    assert.equal(grant.items[0]!.id, undefined, 'no id on an entitlement row');
    const sub = (await get(handler, '/v1/subscriptions?limit=1', 'ada'))
      .body as Page;
    assert.equal(typeof sub.items[0]!.id, 'string');
    assert.equal(typeof sub.items[0]!.sku, 'string', 'and both on a sub row');
  });

  /**
   * The identity is the list's, not the row's, and no rule reading fields off a row can be.
   *
   * One row, two lists, two answers: an entitlement is identified by its sku and a subscription
   * by its id, so handing the same object to both must produce different keys. A structural
   * rule — `id ?? sku`, or its mirror — returns one answer for one row by construction and
   * cannot pass this in both directions at once.
   */
  test('one row read as two lists takes two identities', () => {
    const row = { id: 'sub_1', sku: 'pass-1' };
    assert.equal(wireRowIdentity('entitlements', row), 'sku\0pass-1');
    assert.equal(wireRowIdentity('subscriptions', row), 'id\0sub_1');
    assert.equal(wireRowIdentity('payouts', row), 'id\0sub_1');

    // The field name rides in the key on U+0000, so equal values under different fields cannot
    // collide — the case a bare value would merge.
    assert.notEqual(
      wireRowIdentity('entitlements', { sku: 'x' }),
      wireRowIdentity('payouts', { id: 'x' }),
    );
    assert.equal(wireRowIdentity('payouts', { id: 'x' })!.codePointAt(2), 0);

    // A row with nothing usable in its list's field is not identified, and callers leave it
    // where it is rather than dropping it.
    assert.equal(wireRowIdentity('entitlements', { id: 'sub_1' }), null);
    assert.equal(wireRowIdentity('payouts', { sku: 'pass-1' }), null);
    assert.equal(wireRowIdentity('payouts', { id: 7 }), null);
    assert.equal(wireRowIdentity('payouts', null), null);
    assert.equal(wireRowIdentity('payouts', undefined), null);
  });
});
