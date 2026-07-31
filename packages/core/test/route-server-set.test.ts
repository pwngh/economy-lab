/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

/**
 * A module route is the third door onto `submit`, and the only one besides `/submit` that takes a
 * caller's request body. The lab's wire refuses a server-set field; this holds the route seam to
 * the same answer, holds the refusal it protects reachable on that same door, and holds the rail's
 * own report — the one legitimate writer — still returning the reserve.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestEconomy } from '@pwngh/economy-test';
import type { TestEconomy, OutcomeHandle } from '@pwngh/economy-test';
import { credits } from '@pwngh/economy-money';
import type { OperationDraft, RouteHandler } from '../src/index.js';

// The type half, checked by this package's own `tsc --noEmit` rather than at run time. The draft
// grammar derives its exclusions from the lab's wire table, so the day `providerReported` returns
// to that table the `@ts-expect-error` goes unused and the typecheck fails. The line above it is
// the control: the same draft without the field compiles.
const named: OperationDraft = {
  kind: 'reversePayout',
  userId: 'usr_ben',
  sagaId: 'pay_1',
  reason: 'audit',
};
const waived: OperationDraft = {
  ...named,
  // @ts-expect-error providerReported is server-set and not part of the draft grammar
  providerReported: true,
};
void named;
void waived;

// 20,000 credits is a real cash out at the lab's $0.005/credit payout rate — about $100 the rail
// may still be holding when a waived settlement window hands it back to the seller.
const RESERVE = 20_000;

// The idiomatic admin route: read the body, name the kind, submit. The spread is the shape that
// matters — `request.json()` is untyped, so no draft type can see what rides in on it.
const relay: RouteHandler = async ({ request }) => {
  const body = await request.json();
  return { kind: 'reversePayout', ...body };
};

// A payout the rail is holding: SUBMITTED, well inside the 72-hour `maxPayoutAgeMs` default, so
// the settlement-window refusal is armed. `held` is the seller's earned balance while the reserve
// is out of it — the sale left more than the payout drew, so it is a residue rather than zero.
async function liveSubmittedPayout(): Promise<{
  t: TestEconomy;
  payout: OutcomeHandle;
  held: string;
}> {
  const t = await openTestEconomy({
    policy: { velocityLimitMinor: 10_000_000n },
    routes: { 'POST /admin/reverse-payout': relay },
  });
  const ada = t.user('ada');
  await t.fund(ada, credits(30_000));
  await ada.submit({
    kind: 'spend',
    orderId: 'o1',
    sku: 'kit',
    price: credits(25_000),
    recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
  });
  const payout = await t
    .user('ben')
    .submit({ kind: 'requestPayout', amount: credits(RESERVE) });
  await t.until(async () => (await payout.saga!.state()) === 'SUBMITTED');
  return { t, payout, held: await earnedOf(t) };
}

function reverseThrough(
  t: TestEconomy,
  sagaId: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return t.operator('sre').request('/admin/reverse-payout', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `rev_${sagaId}`,
    },
    body: JSON.stringify({
      userId: 'usr_ben',
      sagaId,
      reason: 'fraud hold',
      ...extra,
    }),
  });
}

const earnedOf = async (t: TestEconomy) =>
  String((await t.economy.read.wallet('usr_ben')).earned.minor);

// What the reserve is worth in minor units, and so what a waived window hands back.
const RETURNED = BigInt(RESERVE) * 100n;

test('a module route naming providerReported is refused, and the reserve stays put', async () => {
  const { t, payout, held } = await liveSubmittedPayout();

  const res = await reverseThrough(t, payout.saga!.id, {
    providerReported: true,
  });
  const problem = (await res.json()) as { title: string; code: string };

  assert.equal(res.status, 400);
  assert.equal(problem.code, 'OP.MALFORMED');
  assert.match(problem.title, /providerReported/);
  assert.equal(await payout.saga!.state(), 'SUBMITTED');
  assert.equal(await earnedOf(t), held, 'the reserve went back to the seller');
  await t.close();
});

// The refusal above is worth nothing unless the guard it protects is reachable on the same door:
// without the flag, the same body against the same payout is refused for the settlement window.
test('the same route without the flag is refused for the settlement window', async () => {
  const { t, payout, held } = await liveSubmittedPayout();

  const res = await reverseThrough(t, payout.saga!.id);
  const problem = (await res.json()) as { title: string; code: string };

  assert.equal(res.status, 409, 'the answer is "not yet", not "we broke"');
  assert.equal(problem.code, 'SAGA.INVALID_TRANSITION');
  assert.equal(
    problem.title,
    'Cannot reverse a payout still within its provider settlement window.',
  );
  assert.equal(await payout.saga!.state(), 'SUBMITTED');
  assert.equal(await earnedOf(t), held);
  await t.close();
});

// The other half. The rail's own report is the one legitimate writer of the field, and it does not
// come through a route: a fix that closed this door and broke that one would pass both cases above.
test("the rail's own payout-failed report still returns the reserve", async () => {
  const { t, payout, held } = await liveSubmittedPayout();

  const failed = await t.rail.fail(payout);

  assert.equal(failed.outcome.status, 'committed');
  assert.equal(await payout.saga!.state(), 'FAILED');
  assert.equal(
    await earnedOf(t),
    String(BigInt(held) + RETURNED),
    'the rail reported failure and the seller did not get the reserve back',
  );
  await t.close();
});
