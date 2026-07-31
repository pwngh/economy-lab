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
 * `providerReported` is server-set, and this holds both halves of that: an HTTP body naming it is
 * refused, so a caller cannot waive the payout settlement-window refusal, and the verified
 * payout-failed callback that legitimately sets it still returns the reserve. A fix that closed
 * the wire and broke the rail's own report would pass the first half and fail the second.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '#src/server.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { encodeAmount } from '#src/money.ts';
import { toReversePayout } from '#src/webhooks.ts';
import { decodeStoredOperation, encodeOperation } from '#src/wire-contract.ts';
import { economyWithStore } from '#test/support/economy.ts';
import { credit, sagaAnchor, usd } from '#test/support/builders.ts';
import { fixedClock, silentMeter } from '#src/runtime.ts';
import {
  fixedRates,
  testConfig,
  testLogger,
  testSecrets,
} from '#test/support/capabilities.ts';

import type { Economy } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Saga, Store } from '#src/ports.ts';
import type { FetchHandler } from '#src/server.ts';

const SELLER = 'usr_seller';
// 20,000 credits is a real cash out at this tree's payout rate ($0.005/credit), so the money the
// waiver hands back is $100 the rail may still be paying.
const RESERVE = credit('20000.00');

/**
 * A payout the rail is holding: SUBMITTED at `updatedAt: 0` against a frozen clock, so its age is
 * 0 ms inside a 24-hour `maxPayoutAgeMs` and the settlement-window refusal is armed. The seeded
 * funding and the anchor posting are what `assertSagaAnchored` re-proves the reserve against.
 */
async function seedLiveSubmittedPayout(
  store: Store,
  sagaId: string,
): Promise<Saga> {
  const row: Saga = {
    id: sagaId,
    state: 'SUBMITTED',
    userId: SELLER,
    reserve: RESERVE,
    rateId: 'payout:CREDIT->USD:1',
    providerRef: `rail_${sagaId}`,
    reason: null,
    attempts: 1,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: usd('100.00'),
    txnId: `txn_anchor_${sagaId}`,
  };
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    await unit.ledger.append({
      txnId: `txn_seed_${sagaId}`,
      legs: [
        creditLeg(earned(row.userId), row.reserve),
        debitLeg(SYSTEM.STORED_VALUE, row.reserve),
      ],
      meta: { kind: 'seed' },
    });
    await unit.ledger.append(sagaAnchor(row));
  });
  return row;
}

function makeServer(economy: Economy): FetchHandler {
  return createServer({
    economy,
    ports: {
      config: testConfig(),
      secrets: testSecrets(),
      clock: fixedClock(0),
      meter: silentMeter(),
      logger: testLogger(),
      rates: fixedRates(),
    },
    authenticate: false,
  });
}

// The operator's own reversal, as the wire carries it. `extra` is what the caller adds beyond the
// contract's four fields.
function reversePayoutBody(
  sagaId: string,
  extra: Record<string, unknown> = {},
): Request {
  return new Request('https://economy.test/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'reversePayout',
      idempotencyKey: `idem_${sagaId}`,
      actor: { kind: 'operator', operatorId: 'op_7' },
      userId: SELLER,
      sagaId,
      reason: 'fraud hold',
      ...extra,
    }),
  });
}

function balanceOf(store: Store, account: AccountRef): Promise<string> {
  return store
    .transaction((unit) => unit.ledger.balance(account))
    .then(encodeAmount);
}

async function stateOf(store: Store, sagaId: string): Promise<string> {
  return (await store.sagas.load(sagaId))?.state ?? 'absent';
}

describe('A Caller Cannot Waive The Payout Settlement Window', () => {
  test('an HTTP reversePayout naming providerReported is refused, and the reserve stays put', async () => {
    const { economy, store } = economyWithStore();
    await seedLiveSubmittedPayout(store, 'pay_wire');

    const response = await makeServer(economy)(
      reversePayoutBody('pay_wire', { providerReported: true }),
    );
    const problem = (await response.json()) as {
      title: string;
      code: string;
    };

    assert.equal(response.status, 400);
    assert.equal(problem.code, 'OP.MALFORMED');
    assert.equal(
      problem.title,
      "Operation field 'providerReported' is not part of reversePayout.",
    );
    assert.equal(await stateOf(store, 'pay_wire'), 'SUBMITTED');
    assert.equal(
      await balanceOf(store, SYSTEM.PAYOUT_RESERVE),
      'CREDIT:20000.00',
    );
    assert.equal(await balanceOf(store, earned(SELLER)), 'CREDIT:0.00');
  });

  // The refusal above is only worth anything while the guard it protects is reachable on the same
  // door: without the flag, the same body against the same saga is refused for the settlement
  // window itself.
  test('the same body without the flag is refused for the settlement window', async () => {
    const { economy, store } = economyWithStore();
    await seedLiveSubmittedPayout(store, 'pay_bare');

    const response = await makeServer(economy)(reversePayoutBody('pay_bare'));
    const problem = (await response.json()) as {
      title: string;
      code: string;
    };

    // 409, not 500: the request was correct and the answer is "not yet", so a client can act on
    // it and a retry loop watching for 5xx has nothing to hammer.
    assert.equal(response.status, 409);
    assert.equal(problem.code, 'SAGA.INVALID_TRANSITION');
    assert.equal(
      problem.title,
      'Cannot reverse a payout still within its provider settlement window.',
    );
    assert.equal(await stateOf(store, 'pay_bare'), 'SUBMITTED');
    assert.equal(
      await balanceOf(store, SYSTEM.PAYOUT_RESERVE),
      'CREDIT:20000.00',
    );
  });

  // The other half of the fix. `toReversePayout` builds the Operation directly and the inbox
  // carries it as JSON, so the rail's own report must still waive the gate that the wire cannot.
  test("the payout-failed callback's own operation still returns the reserve", async () => {
    const { economy, store } = economyWithStore();
    const saga = await seedLiveSubmittedPayout(store, 'pay_rail');

    const built = toReversePayout({
      kind: 'payoutFailed',
      provider: 'payouts',
      eventId: 'evt_fail_1',
      sagaId: saga.id,
      userId: SELLER,
      providerRef: `rail_${saga.id}`,
      reason: 'beneficiary rejected',
    });
    // Through the inbox's JSON column and back, which is how the drain reaches submit.
    const stored = decodeStoredOperation(
      JSON.parse(JSON.stringify(encodeOperation(built))),
    );
    assert.equal(
      (stored as unknown as Record<string, unknown>).providerReported,
      true,
      'the stored operation lost providerReported on the round trip',
    );

    const outcome = await economy.submit(stored);

    assert.equal(outcome.status, 'committed');
    assert.equal(await stateOf(store, 'pay_rail'), 'FAILED');
    assert.equal(await balanceOf(store, SYSTEM.PAYOUT_RESERVE), 'CREDIT:0.00');
    assert.equal(
      await balanceOf(store, earned(SELLER)),
      'CREDIT:20000.00',
      'the rail reported failure and the seller did not get the reserve back',
    );
  });
});
