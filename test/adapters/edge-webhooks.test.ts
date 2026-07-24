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

import { money } from '@pwngh/economy-edge';
import {
  edgePayoutWebhookEvent,
  sagaByProviderRef,
} from '#src/adapters/edge-webhooks.ts';
import { toOperation } from '#src/webhooks.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit, usd } from '#test/support/builders.ts';

import type { CanonicalPayoutEvent } from '@pwngh/economy-edge';
import type { Saga, Store } from '#src/ports.ts';

const REF = { provider: 'tilia', id: 'acct-1/ps-1' } as const;

function payoutEvent(
  overrides: Partial<CanonicalPayoutEvent> & Pick<CanonicalPayoutEvent, 'type'>,
): CanonicalPayoutEvent {
  return {
    schemaVersion: 1,
    provider: 'tilia',
    ref: REF,
    ...overrides,
  };
}

async function storeWithSaga(): Promise<Store> {
  const store = memoryStore();
  const row: Saga = {
    id: 'pay_1',
    userId: 'usr_seller',
    reserve: credit('20000.00'),
    rateId: 'payout:CREDIT->USD:1',
    state: 'SUBMITTED',
    providerRef: REF.id,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
  };
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
  });
  return store;
}

describe('edge-webhooks bridge', () => {
  test('maps a SETTLED payout event onto payoutSettled with the resolved saga', async () => {
    const store = await storeWithSaga();

    const mapped = await edgePayoutWebhookEvent(
      payoutEvent({ type: 'SETTLED' }),
      { eventId: 'evt_1' },
      sagaByProviderRef(store),
    );

    assert.deepEqual(mapped, {
      kind: 'payoutSettled',
      provider: 'tilia',
      eventId: 'evt_1',
      sagaId: 'pay_1',
      providerRef: REF.id,
    });
    const operation = toOperation(mapped!) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(operation.kind, 'settlePayout');
    assert.equal('providerAmount' in operation, false);
  });

  test('carries the settlement gross as the audit amount when the event reports one', async () => {
    const store = await storeWithSaga();

    const mapped = await edgePayoutWebhookEvent(
      payoutEvent({
        type: 'SETTLED',
        settlement: {
          schemaVersion: 1,
          providerTxnId: 'ps-1',
          gross: money('USD', 10_000n),
          fee: money('USD', 150n),
          net: money('USD', 9_850n),
          sourceRef: 'tilia:payout:ps-1',
        },
      }),
      { eventId: 'evt_1' },
      sagaByProviderRef(store),
    );

    assert.equal(mapped!.kind, 'payoutSettled');
    assert.deepEqual(
      mapped!.kind === 'payoutSettled' ? mapped!.providerAmount : undefined,
      usd('100.00'),
    );
  });

  test('maps FAILED and RETURNED onto payoutFailed with the saga user', async () => {
    const store = await storeWithSaga();
    const lookup = sagaByProviderRef(store);

    const failed = await edgePayoutWebhookEvent(
      payoutEvent({ type: 'FAILED' }),
      { eventId: 'evt_f' },
      lookup,
    );
    const returned = await edgePayoutWebhookEvent(
      payoutEvent({ type: 'RETURNED' }),
      { eventId: 'evt_r' },
      lookup,
    );

    assert.deepEqual(failed, {
      kind: 'payoutFailed',
      provider: 'tilia',
      eventId: 'evt_f',
      sagaId: 'pay_1',
      userId: 'usr_seller',
      providerRef: REF.id,
    });
    assert.equal(
      returned!.kind === 'payoutFailed' ? returned!.reason : undefined,
      'payout.provider_returned',
    );
  });

  test('returns null for KYC events, missing refs, and unknown sagas', async () => {
    const store = await storeWithSaga();
    const lookup = sagaByProviderRef(store);

    assert.equal(
      await edgePayoutWebhookEvent(
        payoutEvent({ type: 'KYC_CLEARED' }),
        { eventId: 'evt_k' },
        lookup,
      ),
      null,
    );
    assert.equal(
      await edgePayoutWebhookEvent(
        payoutEvent({ type: 'SETTLED', ref: undefined }),
        { eventId: 'evt_n' },
        lookup,
      ),
      null,
    );
    assert.equal(
      await edgePayoutWebhookEvent(
        payoutEvent({
          type: 'SETTLED',
          ref: { provider: 'tilia', id: 'acct-1/ps-unknown' },
        }),
        { eventId: 'evt_u' },
        lookup,
      ),
      null,
    );
  });
});
