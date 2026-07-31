/**
 * @pwngh/economy-events
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
  EVENT_TYPES as LAB_EVENT_TYPES,
  EVENT_VERSION as LAB_EVENT_VERSION,
} from '@pwngh/economy-lab';

import {
  EVENT_TYPES,
  EVENT_VERSION,
  isEconomyEvent,
  isEvent,
  isEventType,
  narrowEvent,
} from '../src/index.js';
import type { EconomyEvent } from '../src/index.js';

const SETTLED: EconomyEvent = {
  id: 'evt_4c1d9e2a',
  type: 'economy.payout.settled',
  version: 1,
  occurredAt: 1753574400000,
  subject: 'usr_ada',
  audience: 'internal',
  data: {
    sagaId: 'pay_7f2b8c10',
    userId: 'usr_ada',
    reserve: 'CREDIT:20000.00',
    usd: 'USD:100.00',
    payoutFee: 'USD:5.00',
    netUsd: 'USD:95.00',
    rateId: 'payout-2026-07',
  },
};

const SALE: EconomyEvent = {
  id: 'evt_9a3f0b71',
  type: 'economy.sale.completed',
  version: 1,
  occurredAt: 1753574401000,
  subject: 'usr_ada',
  audience: 'client',
  data: { txnId: 'txn_0f8c3a41', isGift: true, giftTo: 'usr_ben' },
};

// The roster is built from the lab's array, so comparing the two back resolves nothing: both sides
// are one read. What is worth holding is that the copy is a copy — frozen, and a different object,
// so a consumer cannot reach through it into the lab's own array. The names themselves are pinned
// against a written-out golden at the bottom of this file.
test('the roster is a frozen copy, not the lab array itself', () => {
  assert.ok(Object.isFrozen(EVENT_TYPES));
  assert.throws(() => (EVENT_TYPES as string[]).push('economy.credits.minted'));
  assert.equal(
    EVENT_TYPES.length,
    14,
    'the push was refused rather than swallowed',
  );
  assert.notEqual(
    EVENT_TYPES,
    LAB_EVENT_TYPES,
    'the copy leaves the lab array unfrozen',
  );
  assert.equal(
    Object.isFrozen(LAB_EVENT_TYPES),
    false,
    'freezing in place would reach into a module this package only reads',
  );
});

test('isEventType admits a rostered name and nothing else', () => {
  assert.ok(isEventType('economy.subscription.lapsed'));
  assert.equal(isEventType('economy.subscription.lapse'), false);
  assert.equal(isEventType('economy.credits.minted'), false);
  assert.equal(isEventType(undefined), false);
  assert.equal(isEventType(14), false);
});

// Two independently declared numbers: the lab stamps its own on every event, this package publishes
// its own for consumers to decode against. A raise on one side that misses the other ships events
// nothing decodes, so the gate is the comparison across the seam — not a literal, and not this
// file's fixtures, which state whatever they are written to state.
// What every EMITTER stamps is a different claim, and it is resolved in emitted.test.ts, which
// reads all fourteen types back out of the outbox.
test('EVENT_VERSION is the version the lab stamps, not a second number', () => {
  assert.equal(EVENT_VERSION, LAB_EVENT_VERSION);
});

test('a narrowed event carries its own data under a switch', () => {
  const event = narrowEvent(JSON.parse(JSON.stringify(SETTLED)));
  assert.ok(event !== null);

  let netUsd = '';
  let gift: string | undefined;
  for (const each of [event, narrowEvent(SALE)!]) {
    switch (each.type) {
      case 'economy.payout.settled':
        netUsd = each.data.netUsd;
        break;
      case 'economy.sale.completed':
        gift = each.data.giftTo;
        break;
      default:
        break;
    }
  }

  assert.equal(netUsd, 'USD:95.00');
  assert.equal(gift, 'usr_ben');
});

test('narrowEvent refuses anything that is not a rostered event', () => {
  assert.equal(
    narrowEvent({ ...SETTLED, type: 'economy.credits.minted' }),
    null,
  );
  assert.equal(narrowEvent({ ...SETTLED, audience: 'everyone' }), null);
  assert.equal(narrowEvent({ ...SETTLED, occurredAt: '1753574400000' }), null);
  assert.equal(narrowEvent({ ...SETTLED, data: null }), null);
  assert.equal(narrowEvent('economy.payout.settled'), null);
  assert.equal(narrowEvent(null), null);
});

test('a missing envelope field is not an event', () => {
  const { subject: _subject, ...withoutSubject } = SETTLED;
  assert.equal(isEconomyEvent(withoutSubject), false);
  assert.ok(isEconomyEvent(SETTLED));
});

test('isEvent narrows a single type and declines its neighbours', () => {
  assert.ok(isEvent(SALE, 'economy.sale.completed'));
  assert.equal(isEvent(SALE, 'economy.sale.refunded'), false);

  if (isEvent(SETTLED, 'economy.payout.settled')) {
    assert.equal(SETTLED.data.sagaId, 'pay_7f2b8c10');
    assert.equal(SETTLED.data.rateId, 'payout-2026-07');
  } else {
    assert.fail('the settled payout did not narrow');
  }
});

// A queue hands a consumer parsed JSON, and a guard that narrows on the type alone hands back a
// value whose `data` the caller then reads fields off that were never there.
//
// Every row here carries the type being probed for, so the type comparison decides none of them and
// the envelope check is the only thing that can refuse. A row typed something else would pass
// against a guard reduced to a bare `value.type === type`, which is the reduction this test exists
// to catch; that reduction is asserted directly below.
test('isEvent refuses junk carrying the very type asked for', () => {
  const SWEPT = { ...SETTLED, type: 'economy.fees.swept' };
  const { version: _version, ...noVersion } = SWEPT;
  const { subject: _subject, ...noSubject } = SWEPT;
  const junk: Array<[string, unknown]> = [
    ['a bare string', 'economy.fees.swept'],
    ['the type alone', { type: 'economy.fees.swept' }],
    ['a string version', { ...SWEPT, version: '1' }],
    ['null data', { ...SWEPT, data: null }],
    ['array data', { ...SWEPT, data: [] }],
    ['an unrostered audience', { ...SWEPT, audience: 'everyone' }],
    ['a string occurredAt', { ...SWEPT, occurredAt: '1753574400000' }],
    ['no version at all', noVersion],
    ['no subject', noSubject],
  ];
  for (const [why, value] of junk) {
    assert.equal(
      isEvent(value as never, 'economy.fees.swept'),
      false,
      `isEvent narrowed ${why}`,
    );
  }
  assert.equal(junk.length, 9, 'nine malformed envelopes, all correctly typed');
  assert.ok(
    isEvent(SWEPT as never, 'economy.fees.swept'),
    'the same envelope, well formed, still narrows',
  );
  // The one row the type comparison alone would refuse, kept so both halves are stated.
  assert.equal(isEvent(SALE, 'economy.fees.swept'), false);
  assert.equal(isEvent(null as never, 'economy.fees.swept'), false);
  assert.equal(isEvent(undefined as never, 'economy.fees.swept'), false);
});

test('an array is not the data object an event carries', () => {
  assert.equal(narrowEvent({ ...SETTLED, data: [] }), null);
  assert.equal(isEconomyEvent({ ...SETTLED, data: [] }), false);
  assert.ok(
    isEconomyEvent({ ...SETTLED, data: {} }),
    'an empty object is still an object',
  );
});

// The roster is copied from the lab, so comparing it back to the lab proves only that the copy
// copied. These are the fourteen names, written out, so a rename on either side has to be read.
test('the roster is these fourteen names', () => {
  assert.deepEqual(
    [...EVENT_TYPES],
    [
      'economy.credits.topped_up',
      'economy.credits.clawed_back',
      'economy.promo.granted',
      'economy.sale.completed',
      'economy.sale.refunded',
      'economy.subscription.started',
      'economy.subscription.renewed',
      'economy.subscription.canceled',
      'economy.subscription.lapsed',
      'economy.payout.requested',
      'economy.payout.settled',
      'economy.payout.reversed',
      'economy.fees.swept',
      'economy.instance.settled',
    ],
  );
});
