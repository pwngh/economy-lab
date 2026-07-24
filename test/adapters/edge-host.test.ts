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
import { createHmac } from 'node:crypto';

import {
  tiliaPayoutWebhookBody,
  tiliaScenario,
} from '@pwngh/economy-edge/testing';
import { maybeEdgeTilia, tiliaWebhook } from '#scripts/support/edge-host.ts';
import { edgeTiliaCapabilities } from '#src/adapters/edge-tilia.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit } from '#test/support/builders.ts';
import {
  fixedClock,
  sequentialIds,
  testLogger,
} from '#test/support/capabilities.ts';

import type { Saga, Store } from '#src/ports.ts';

async function storeWithSubmittedSaga(providerRef: string): Promise<Store> {
  const store = memoryStore();
  const row: Saga = {
    id: 'pay_1',
    userId: 'usr_seller',
    reserve: credit('4.00'),
    rateId: 'payout:CREDIT->USD:1',
    txnId: 'txn_anchor_edge_host',
    state: 'SUBMITTED',
    providerRef,
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

describe('edge-host bridge', () => {
  test('stays off without TILIA_CLIENT_ID', async () => {
    assert.equal(await maybeEdgeTilia({}, testLogger()), undefined);
  });

  test('an incomplete opt-in fails loudly, listing every missing key', async () => {
    await assert.rejects(
      maybeEdgeTilia({ TILIA_CLIENT_ID: 'client' }, testLogger()),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        return (
          message.includes('TILIA_CLIENT_SECRET') &&
          message.includes('TILIA_ACCOUNT_ID') &&
          message.includes('TILIA_PAYEE_MAP')
        );
      },
    );
  });

  test('a malformed payee map entry fails loudly, naming the user', async () => {
    await assert.rejects(
      maybeEdgeTilia(
        {
          TILIA_CLIENT_ID: 'client',
          TILIA_CLIENT_SECRET: 'secret',
          TILIA_ACCOUNT_ID: 'acct',
          TILIA_PAYEE_MAP: JSON.stringify({ usr_x: { accountId: 'a' } }),
        },
        testLogger(),
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes('usr_x'),
    );
  });

  test('a failed-payout callback lands in the inbox as a reversePayout exactly once', async () => {
    const scenario = tiliaScenario();
    const edge = edgeTiliaCapabilities(scenario.config);
    const store = await storeWithSubmittedSaga(scenario.ref.id);
    const handler = tiliaWebhook(edge, store, {
      ids: sequentialIds(),
      clock: fixedClock(0),
    });
    const deliver = () =>
      handler(
        'tilia',
        new Request('https://economy.test/webhooks/tilia', {
          method: 'POST',
          body: tiliaPayoutWebhookBody('FAILED'),
        }),
      );

    const first = await deliver();
    const second = await deliver();

    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      status: 'accepted',
      applied: 1,
      skipped: 0,
    });
    assert.equal(second.status, 200);
    const rows = await store.inbox.claimInbound({ now: 0, limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.operation.kind, 'reversePayout');
  });

  test('a re-serialized redelivery dedupes on the status transition, not the body bytes', async () => {
    const scenario = tiliaScenario();
    const edge = edgeTiliaCapabilities(scenario.config);
    const store = await storeWithSubmittedSaga(scenario.ref.id);
    const handler = tiliaWebhook(edge, store, {
      ids: sequentialIds(),
      clock: fixedClock(0),
    });
    const body = tiliaPayoutWebhookBody('FAILED');
    const deliver = (payload: string) =>
      handler(
        'tilia',
        new Request('https://economy.test/webhooks/tilia', {
          method: 'POST',
          body: payload,
        }),
      );

    await deliver(body);
    await deliver(`  ${body}`);

    const rows = await store.inbox.claimInbound({ now: 0, limit: 10 });
    assert.equal(rows.length, 1);
  });

  test('an unsigned callback is refused with a 401 under a signing scheme', async () => {
    const scenario = tiliaScenario();
    const edge = edgeTiliaCapabilities({
      ...scenario.config,
      webhookVerification: {
        scheme: 'hmac-sha256',
        secret: 'whsec_host',
        header: 'x-tilia-signature',
      },
    });
    const store = await storeWithSubmittedSaga(scenario.ref.id);
    const handler = tiliaWebhook(edge, store, {
      ids: sequentialIds(),
      clock: fixedClock(0),
    });

    const response = await handler(
      'tilia',
      new Request('https://economy.test/webhooks/tilia', {
        method: 'POST',
        body: tiliaPayoutWebhookBody('FAILED'),
      }),
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await store.inbox.claimInbound({ now: 0, limit: 10 }), []);
  });

  test('a correctly signed callback is applied under the same signing scheme', async () => {
    const scenario = tiliaScenario();
    const edge = edgeTiliaCapabilities({
      ...scenario.config,
      webhookVerification: {
        scheme: 'hmac-sha256',
        secret: 'whsec_host',
        header: 'x-tilia-signature',
      },
    });
    const store = await storeWithSubmittedSaga(scenario.ref.id);
    const handler = tiliaWebhook(edge, store, {
      ids: sequentialIds(),
      clock: fixedClock(0),
    });
    const body = tiliaPayoutWebhookBody('FAILED');
    const signature = createHmac('sha256', 'whsec_host')
      .update(body)
      .digest('hex');

    const response = await handler(
      'tilia',
      new Request('https://economy.test/webhooks/tilia', {
        method: 'POST',
        headers: { 'x-tilia-signature': signature },
        body,
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'accepted',
      applied: 1,
      skipped: 0,
    });
  });

  test('an unrecognizable callback is acknowledged and skipped, never dropped as an error', async () => {
    const scenario = tiliaScenario();
    const edge = edgeTiliaCapabilities(scenario.config);
    const store = await storeWithSubmittedSaga(scenario.ref.id);
    const handler = tiliaWebhook(edge, store, {
      ids: sequentialIds(),
      clock: fixedClock(0),
    });

    const response = await handler(
      'tilia',
      new Request('https://economy.test/webhooks/tilia', {
        method: 'POST',
        body: 'not json',
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'accepted',
      applied: 0,
      skipped: 1,
    });
    assert.deepEqual(await store.inbox.claimInbound({ now: 0, limit: 10 }), []);
  });
});

describe('edge-host production posture', () => {
  function recordingLogger() {
    const lines: [string, string, Record<string, unknown>][] = [];
    return {
      lines,
      log: (
        level: 'debug' | 'info' | 'warn' | 'error',
        event: string,
        fields: Record<string, unknown>,
      ) => {
        lines.push([level, event, fields]);
      },
    };
  }
  const staging = {
    TILIA_CLIENT_ID: 'client',
    TILIA_CLIENT_SECRET: 'secret',
    TILIA_ACCOUNT_ID: 'acct',
    TILIA_PAYEE_MAP: JSON.stringify({}),
  };

  test('the production rail requires signed callbacks and a durable payee store', async () => {
    await assert.rejects(
      maybeEdgeTilia(
        { ...staging, TILIA_ENVIRONMENT: 'production' },
        testLogger(),
      ),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        return (
          message.includes('TILIA_WEBHOOK_SECRET') &&
          message.includes('TILIA_PAYEE_DATABASE_URL')
        );
      },
    );
  });

  test('staging without a webhook secret boots on transport and says so', async () => {
    const logger = recordingLogger();
    const host = await maybeEdgeTilia(staging, logger);
    assert.notEqual(host, undefined);
    assert.ok(
      logger.lines.some(
        ([level, event]) =>
          level === 'warn' && event === 'edge.tilia_webhooks_unsigned',
      ),
    );
    assert.ok(
      logger.lines.some(
        ([, event, fields]) =>
          event === 'edge.tilia_ready' &&
          (fields as { webhooks?: string }).webhooks === 'transport',
      ),
    );
    await host?.stop();
  });

  test('a webhook secret upgrades the scheme and edge.tilia_ready reports it', async () => {
    const logger = recordingLogger();
    const host = await maybeEdgeTilia(
      { ...staging, TILIA_WEBHOOK_SECRET: 'shh' },
      logger,
    );
    assert.notEqual(host, undefined);
    assert.ok(
      logger.lines.some(
        ([, event, fields]) =>
          event === 'edge.tilia_ready' &&
          (fields as { webhooks?: string }).webhooks === 'hmac-sha256',
      ),
    );
    await host?.stop();
  });
});
