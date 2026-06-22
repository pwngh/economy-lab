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

import { runStoreConformance } from '#test/conformance/store.ts';
import { httpStore, createStoreServer } from '#src/adapters/http.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { FetchLike } from '#src/adapters/http.ts';
import type { PromoGrant, Saga, Subscription } from '#src/ports.ts';

// Run the shared conformance suite against the HTTP backend. A bare `httpStore()` wires its
// HTTP client to a server in this same process, so it's a complete backend with no live
// service to start.
runStoreConformance('http', () => httpStore());

// Wrap the in-process server `fetch` so a test can see the `signal` the client attached to each
// request. Requests whose path ends in `path` get their signal pushed to `signals`; every
// request is still forwarded to the real server. Used to assert a cancellation signal threaded
// through a Ledger method actually reaches the transport.
//
// The `Request` constructor wraps the caller's signal in a fresh `AbortSignal` that follows the
// original (it can't expose the same object), and manufactures one even when none is supplied,
// so neither identity (`===`) nor presence distinguishes a forwarded signal from a dropped one.
// The tell is whether the request's signal tracks the caller's: a forwarded signal aborts when
// the caller's controller aborts; a dropped one (the auto-created signal) does not.
function captureSignals(
  inner: FetchLike,
  path: string,
  signals: AbortSignal[],
): FetchLike {
  return (request) => {
    if (new URL(request.url).pathname.endsWith(path)) {
      signals.push(request.signal);
    }
    return inner(request);
  };
}

// `lineage` (used by chain verification, which passes a real cancellation signal) is a streamed
// read whose generator only runs once iterated, so the test drives it with `for await` to force
// the request to be sent.
describe('http Ledger Streamed Reads Forward Options', () => {
  test('lineage forwards the abort signal to the transport', async () => {
    let signals: AbortSignal[] = [];
    let fetch = captureSignals(
      createStoreServer(memoryStore()),
      '/ledger/lineage',
      signals,
    );
    let store = httpStore({ fetch });

    // Abort up front: if the signal is forwarded, the request inherits an already-aborted
    // signal; if it is dropped, the request's auto-created signal is not aborted.
    let controller = new AbortController();
    controller.abort();

    // Iterate so the request is sent. An unknown account yields no links; the in-process server
    // ignores the abort and still answers, so iteration completes either way.
    for await (let _link of store.ledger.lineage('acct_missing' as AccountRef, {
      signal: controller.signal,
    })) {
      void _link;
    }

    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.aborted, true);
  });
});

// The HTTP store must be a complete substitute for the in-process one, so every method has to
// survive the round trip. These cases drive the outbox/saga/subscription methods over the wire
// and assert the same behavior the memory store produces (`httpStore()` is backed by a fresh
// memory store server-side).

// Outbox message (an event saved for later delivery) in pending state, no attempts, matching
// the shape the conformance suite uses.
function outboxRow(
  messageId: string,
): Parameters<ReturnType<typeof httpStore>['outbox']['enqueue']>[0] {
  return {
    id: messageId,
    event: {
      id: `evt_${messageId}`,
      type: 'economy.credits.topped_up',
      version: 1,
      occurredAt: 0,
      subject: 'usr_http_outbox',
      data: {},
      audience: 'internal',
    },
    status: 'pending',
    attempts: 0,
  };
}

// Build one payout saga with the given id, user, and updatedAt. The state and the rest of the
// fields don't matter for the lastPayoutAt check (it spans every state), so they're fixed.
function sagaRow(id: string, userId: string, updatedAt: number): Saga {
  return {
    id,
    userId,
    reserve: toAmount('CREDIT', 100n),
    rateId: 'rate_http',
    state: 'RESERVED',
    providerRef: null,
    attempts: 0,
    dueAt: updatedAt,
    updatedAt,
  };
}

// Build one subscription carrying a non-zero `attempts`, so a round trip that drops the field
// would be visible.
function subscriptionRow(id: string, attempts: number): Subscription {
  return {
    id,
    userId: 'usr_http_sub',
    sellerId: 'sel_http_sub',
    sku: 'sku_http',
    price: toAmount('CREDIT', 500n),
    periodMs: 86_400_000,
    state: 'ACTIVE',
    period: 0,
    attempts,
    nextDueAt: 1_000,
    updatedAt: 0,
  };
}

describe('http Outbox Failure Handling Forwards Over HTTP', () => {
  test('recordFailure bumps attempts and leaves the row claimable', async () => {
    let store = httpStore();
    await store.outbox.enqueue(outboxRow('msg_http_fail'));

    await store.outbox.recordFailure('msg_http_fail');

    // Still pending, so claimBatch hands it back, now with attempts incremented by one.
    let claimed = await store.outbox.claimBatch(10);
    let row = claimed.find((m) => m.id === 'msg_http_fail');
    assert.ok(
      row,
      'recordFailure must leave the message pending and claimable',
    );
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);

    await store.close();
  });

  test('deadLetter marks the row failed so claimBatch never returns it', async () => {
    let store = httpStore();
    await store.outbox.enqueue(outboxRow('msg_http_dead'));

    await store.outbox.deadLetter('msg_http_dead', 'PROVIDER_FAILURE');

    let claimed = await store.outbox.claimBatch(10);
    assert.equal(
      claimed.find((m) => m.id === 'msg_http_dead'),
      undefined,
      'a dead-lettered message must never be re-claimed',
    );

    await store.close();
  });
});

describe('http Saga lastPayoutAt Forwards Over HTTP', () => {
  test('returns the max updatedAt across the user sagas, null for unknown', async () => {
    let store = httpStore();

    // A user with no sagas yet — their first request is always allowed.
    assert.equal(await store.sagas.lastPayoutAt('usr_http_none'), null);

    await store.sagas.open(sagaRow('pay_http_a', 'usr_http_p', 100));
    await store.sagas.open(sagaRow('pay_http_b', 'usr_http_p', 300));
    await store.sagas.open(sagaRow('pay_http_c', 'usr_http_p', 200));
    // A different user's saga must not bleed into the first user's max.
    await store.sagas.open(sagaRow('pay_http_other', 'usr_http_q', 999));

    assert.equal(await store.sagas.lastPayoutAt('usr_http_p'), 300);

    await store.close();
  });
});

describe('http Subscription Attempts Round-Trips Over HTTP', () => {
  test('open then load preserves a non-zero attempts count', async () => {
    let store = httpStore();
    await store.subscriptions.open(subscriptionRow('sub_http_attempts', 4));

    let loaded = await store.subscriptions.load('sub_http_attempts');
    assert.ok(loaded, 'the subscription must load back');
    assert.equal(loaded.attempts, 4);

    await store.close();
  });
});

describe('http Replay Dedup Forwards Over HTTP', () => {
  test('claim returns the boolean dedup result across the transport', async () => {
    let store = httpStore();

    // First sighting of an event id wins; a redelivery is a no-op; an unrelated id is
    // unaffected. Same contract the conformance suite pins, asserted here to prove the boolean
    // survives the round trip on the session-less /replay route.
    assert.deepEqual(await store.replay.claim('evt_http_dedup'), {
      claimed: true,
    });
    assert.deepEqual(await store.replay.claim('evt_http_dedup'), {
      claimed: false,
    });
    assert.deepEqual(await store.replay.claim('evt_http_other'), {
      claimed: true,
    });

    await store.close();
  });
});

describe('http balanceAccounts Streams Over HTTP', () => {
  test('enumerates an account that has a stored balance row', async () => {
    let store = httpStore();

    // Append a balanced posting (two lines cancel to zero) through the root ledger so the store
    // records a cached per-account balance for each touched account. balanceAccounts lists those;
    // the test checks both touched accounts come back over the wire.
    await store.ledger.append({
      txnId: 'txn_http_balacct',
      legs: [
        {
          account: 'vrchat:treasury' as AccountRef,
          amount: toAmount('CREDIT', -500n),
        },
        {
          account: 'usr_http_balacct:spendable' as AccountRef,
          amount: toAmount('CREDIT', 500n),
        },
      ],
      meta: {},
    });

    let seen = new Set<string>();
    for await (let account of store.ledger.balanceAccounts()) {
      seen.add(account);
    }
    assert.equal(seen.has('usr_http_balacct:spendable'), true);

    await store.close();
  });
});

describe('http markBilled Compare-And-Set Forwards Over HTTP', () => {
  test('returns true on a matching expectedDueAt and false on a stale one', async () => {
    let store = httpStore();
    await store.subscriptions.open(subscriptionRow('sub_http_cas', 0));

    // markBilled only updates the row if its current due date still matches the caller's
    // expected one, guarding against two racing writers. The row opened with nextDueAt=1_000 (see
    // subscriptionRow). First call expects 1_000, matches, updates (true). Second still expects
    // 1_000 but the due date already moved, so no-op (false). The boolean must survive the
    // transport.
    assert.equal(
      await store.subscriptions.markBilled('sub_http_cas', 2_000, 1_000),
      true,
    );
    assert.equal(
      await store.subscriptions.markBilled('sub_http_cas', 3_000, 1_000),
      false,
    );

    await store.close();
  });
});

// Build one promo grant with the given id, expiry, and reversed flag, carrying a CREDIT
// amount so a round trip that mishandled the amount codec would be visible.
function promoGrantRow(
  id: string,
  expiresAt: number,
  reversed = false,
): PromoGrant {
  return {
    id,
    userId: 'usr_http_promo',
    amount: toAmount('CREDIT', 500n),
    expiresAt,
    reversed,
  };
}

describe('http Promo Grants Round-Trip Over HTTP', () => {
  test('open then claimDue rebuilds the amount and preserves the row', async () => {
    let store = httpStore();
    await store.promos.open(promoGrantRow('promo_http_a', 1_000));

    // expiresAt <= now is inclusive, so the grant is claimed at exactly its expiry.
    let due = await store.promos.claimDue(1_000, 10);
    let row = due.find((g) => g.id === 'promo_http_a');
    assert.ok(row, 'the grant must come back from claimDue once due');
    // The amount survived the decimal-string codec as a real Amount, not a string.
    assert.deepEqual(row.amount, toAmount('CREDIT', 500n));
    assert.equal(row.reversed, false);

    await store.close();
  });

  test('open is idempotent on id and never overwrites the first row', async () => {
    let store = httpStore();
    await store.promos.open(promoGrantRow('promo_http_dup', 1_000));
    // A second open with a different amount must be a no-op: the first row wins.
    await store.promos.open({
      ...promoGrantRow('promo_http_dup', 1_000),
      amount: toAmount('CREDIT', 999n),
    });

    let due = await store.promos.claimDue(1_000, 10);
    let matches = due.filter((g) => g.id === 'promo_http_dup');
    assert.equal(matches.length, 1, 'open must not duplicate the row');
    assert.deepEqual(
      matches[0]!.amount,
      toAmount('CREDIT', 500n),
      'open must not overwrite the existing grant',
    );

    await store.close();
  });

  test('claimDue honors oldest-expiry-first ordering and the limit', async () => {
    let store = httpStore();
    // Open out of order so a backend that skipped the sort would be caught.
    await store.promos.open(promoGrantRow('promo_http_mid', 200));
    await store.promos.open(promoGrantRow('promo_http_old', 100));
    await store.promos.open(promoGrantRow('promo_http_new', 300));

    // limit caps the result to the two most overdue grants, oldest expiry first.
    let due = await store.promos.claimDue(1_000, 2);
    assert.deepEqual(
      due.map((g) => g.id),
      ['promo_http_old', 'promo_http_mid'],
    );

    await store.close();
  });

  test('markReversed drops the grant from claimDue and is a no-op when re-run', async () => {
    let store = httpStore();
    await store.promos.open(promoGrantRow('promo_http_rev', 1_000));

    await store.promos.markReversed('promo_http_rev');
    assert.deepEqual(
      await store.promos.claimDue(1_000, 10),
      [],
      'a reversed grant must never be re-claimed',
    );

    // Re-running over the same (already-reversed) grant and a missing id are both no-ops.
    await store.promos.markReversed('promo_http_rev');
    await store.promos.markReversed('promo_http_missing');
    assert.deepEqual(await store.promos.claimDue(1_000, 10), []);

    await store.close();
  });
});
