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

// A bare `httpStore()` wires its client to an in-process server, so no live service is needed.
runStoreConformance('http', () => httpStore());

// Captures the `signal` of each request whose path ends in `path`, still forwarding to the server.
// The Request constructor wraps the caller's signal in a fresh follower and manufactures one even
// when none is given, so neither identity nor presence proves forwarding — only whether the
// request's signal tracks the caller's abort does.
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

// The lineage generator only runs once iterated, so the test drives it with `for await` to
// force the request to be sent.
describe('http Ledger Streamed Reads Forward Options', () => {
  test('lineage forwards the abort signal to the transport', async () => {
    const signals: AbortSignal[] = [];
    const fetch = captureSignals(
      createStoreServer(memoryStore()),
      '/ledger/lineage',
      signals,
    );
    const store = httpStore({ fetch });

    // Abort up front: a forwarded signal arrives already aborted; a dropped one does not.
    const controller = new AbortController();
    controller.abort();

    // The in-process server ignores the abort and an unknown account yields no links, so
    // iteration completes either way.
    for await (const _link of store.ledger.lineage(
      'acct_missing' as AccountRef,
      {
        signal: controller.signal,
      },
    )) {
      void _link;
    }

    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.aborted, true);
  });
});

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
    reason: null,
  };
}

// Only id, user, and updatedAt matter to the lastPayoutAt check, which spans every state.
function sagaRow(id: string, userId: string, updatedAt: number): Saga {
  return {
    id,
    userId,
    reserve: toAmount('CREDIT', 100n),
    rateId: 'rate_http',
    state: 'RESERVED',
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: updatedAt,
    updatedAt,
    payoutUsd: null,
  };
}

// Builds one subscription carrying a non-zero `attempts`, so a round trip that dropped the field
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
    const store = httpStore();
    await store.outbox.enqueue(outboxRow('msg_http_fail'));

    await store.outbox.recordFailure('msg_http_fail');

    const claimed = await store.outbox.claimBatch(10);
    const row = claimed.find((m) => m.id === 'msg_http_fail');
    assert.ok(
      row,
      'recordFailure must leave the message pending and claimable',
    );
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);

    await store.close();
  });

  test('deadLetter marks the row failed so claimBatch never returns it', async () => {
    const store = httpStore();
    await store.outbox.enqueue(outboxRow('msg_http_dead'));

    await store.outbox.deadLetter('msg_http_dead', 'PROVIDER_FAILURE');

    const claimed = await store.outbox.claimBatch(10);
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
    const store = httpStore();

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
    const store = httpStore();
    await store.subscriptions.open(subscriptionRow('sub_http_attempts', 4));

    const loaded = await store.subscriptions.load('sub_http_attempts');
    assert.ok(loaded, 'the subscription must load back');
    assert.equal(loaded.attempts, 4);

    await store.close();
  });
});

describe('http Replay Dedup Forwards Over HTTP', () => {
  test('claim returns the boolean dedup result across the transport', async () => {
    const store = httpStore();

    // The conformance suite already pins this contract; asserted again here to prove the boolean
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
    const store = httpStore();

    await store.ledger.append({
      txnId: 'txn_http_balacct',
      legs: [
        {
          account: 'platform:treasury' as AccountRef,
          amount: toAmount('CREDIT', -500n),
        },
        {
          account: 'usr_http_balacct:spendable' as AccountRef,
          amount: toAmount('CREDIT', 500n),
        },
      ],
      meta: {},
    });

    const seen = new Set<string>();
    for await (const account of store.ledger.balanceAccounts()) {
      seen.add(account);
    }
    assert.equal(seen.has('usr_http_balacct:spendable'), true);

    await store.close();
  });
});

describe('http markBilled Compare-And-Set Forwards Over HTTP', () => {
  test('returns true on a matching expectedDueAt and false on a stale one', async () => {
    const store = httpStore();
    await store.subscriptions.open(subscriptionRow('sub_http_cas', 0));

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

// Carries a CREDIT amount so a round trip that mishandled the amount codec would be visible.
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
    const store = httpStore();
    await store.promos.open(promoGrantRow('promo_http_a', 1_000));

    // expiresAt <= now is inclusive, so the grant is claimed at exactly its expiry.
    const due = await store.promos.claimDue(1_000, 10);
    const row = due.find((g) => g.id === 'promo_http_a');
    assert.ok(row, 'the grant must come back from claimDue once due');
    assert.deepEqual(row.amount, toAmount('CREDIT', 500n));
    assert.equal(row.reversed, false);

    await store.close();
  });

  test('open is idempotent on id and never overwrites the first row', async () => {
    const store = httpStore();
    await store.promos.open(promoGrantRow('promo_http_dup', 1_000));
    await store.promos.open({
      ...promoGrantRow('promo_http_dup', 1_000),
      amount: toAmount('CREDIT', 999n),
    });

    const due = await store.promos.claimDue(1_000, 10);
    const matches = due.filter((g) => g.id === 'promo_http_dup');
    assert.equal(matches.length, 1, 'open must not duplicate the row');
    assert.deepEqual(
      matches[0]!.amount,
      toAmount('CREDIT', 500n),
      'open must not overwrite the existing grant',
    );

    await store.close();
  });

  test('claimDue honors oldest-expiry-first ordering and the limit', async () => {
    const store = httpStore();
    // Open out of order so a backend that skipped the sort would be caught.
    await store.promos.open(promoGrantRow('promo_http_mid', 200));
    await store.promos.open(promoGrantRow('promo_http_old', 100));
    await store.promos.open(promoGrantRow('promo_http_new', 300));

    const due = await store.promos.claimDue(1_000, 2);
    assert.deepEqual(
      due.map((g) => g.id),
      ['promo_http_old', 'promo_http_mid'],
    );

    await store.close();
  });

  test('markReversed drops the grant from claimDue and is a no-op when re-run', async () => {
    const store = httpStore();
    await store.promos.open(promoGrantRow('promo_http_rev', 1_000));

    await store.promos.markReversed('promo_http_rev');
    assert.deepEqual(
      await store.promos.claimDue(1_000, 10),
      [],
      'a reversed grant must never be re-claimed',
    );

    await store.promos.markReversed('promo_http_rev');
    await store.promos.markReversed('promo_http_missing');
    assert.deepEqual(await store.promos.claimDue(1_000, 10), []);

    await store.close();
  });
});
