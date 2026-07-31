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

import {
  createServer,
  principalKey,
  problemResponse,
  readBounded,
} from '#src/server.ts';
import { encodeAmount } from '#src/money.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { credit } from '#test/support/builders.ts';
import {
  fixedClock,
  fixedRates,
  hasCode,
  silentMeter,
  testConfig,
  testLogger,
  testSecrets,
} from '#test/support/capabilities.ts';
import { signHex, webhookRequest } from '#test/support/http-sign.ts';

import type { Economy } from '#src/contract.ts';
import type { Config, Secrets } from '#src/config.ts';
import type { ReplayStore } from '#src/ports.ts';
import type {
  FetchHandler,
  ServerOptions,
  ServerPorts,
  WebhookHandler,
} from '#src/server.ts';

// The refusal has to name the knob and its range, not report that "config is invalid".
const WINDOW_FRAGMENT =
  'config.freshnessWindowMs must be a whole number from 0 to 86400000';

// The narrow bag the routes read, from the deterministic test doubles; any slot overridable.
function testPorts(
  overrides: Partial<Omit<ServerPorts, 'secrets'>> & {
    secrets?: Partial<Secrets>;
  } = {},
): ServerPorts {
  return {
    config: overrides.config ?? testConfig(),
    secrets: { ...testSecrets(), ...overrides.secrets },
    clock: overrides.clock ?? fixedClock(0),
    meter: overrides.meter ?? silentMeter(),
    logger: overrides.logger ?? testLogger(),
    rates: overrides.rates ?? fixedRates(),
  };
}

// A server over a fresh test economy: default ports, body actor trusted unless the test
// supplies its own authenticate.
function makeServer(options: Partial<ServerOptions> = {}): FetchHandler {
  return createServer({
    economy: makeEconomy(),
    ports: testPorts(),
    authenticate: false,
    ...options,
  });
}

// Money fields must already be decimal strings — the wire form the server decodes.
function submitRequest(body: Record<string, unknown>): Request {
  return new Request('https://economy.test/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function topUpBody(userId: string, dollars: string): Record<string, unknown> {
  return {
    kind: 'topUp',
    idempotencyKey: `idem_${userId}_${dollars}`,
    actor: { kind: 'system', service: 'test' },
    userId,
    source: 'card',
    amount: encodeAmount(credit(dollars)),
  };
}

// For a buyer with no balance, so the spend is a clean decline.
function spendBody(buyerId: string, dollars: string): Record<string, unknown> {
  return {
    kind: 'spend',
    idempotencyKey: `idem_spend_${buyerId}`,
    actor: { kind: 'user', userId: buyerId },
    orderId: `ord_${buyerId}`,
    buyerId,
    sku: 'sku_demo',
    price: encodeAmount(credit(dollars)),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  };
}

describe('createServer /submit', () => {
  test('commits a valid operation and returns 200 with the encoded transaction', async () => {
    const server = makeServer();

    const response = await server(
      submitRequest(topUpBody('usr_buyer', '10.00')),
    );
    const payload = (await response.json()) as {
      status: string;
      transaction: { legs: Array<{ account: string; amount: string }> };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'committed');
    // No raw integer on the wire: legs report decimal strings like 'CREDIT:10.00'.
    assert.equal(
      payload.transaction.legs.some((leg) => leg.amount === 'CREDIT:10.00'),
      true,
    );
  });

  test('returns 200 with the rejected Outcome for a valid decline', async () => {
    const server = makeServer();

    const response = await server(
      submitRequest(spendBody('usr_broke', '5.00')),
    );
    const payload = (await response.json()) as {
      status: string;
      reason: string;
      detail?: { reason?: string; need?: unknown; have?: unknown };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'rejected');
    // The top-level reason is kept on the wire, derived from detail.reason.
    assert.equal(payload.reason, 'INSUFFICIENT_FUNDS');
    assert.equal(payload.detail?.reason, 'INSUFFICIENT_FUNDS');
    // Detail Amounts ride the wire as the same decimal strings every other amount uses.
    assert.equal(payload.detail?.need, 'CREDIT:5.00');
    assert.equal(payload.detail?.have, 'CREDIT:0.00');
  });

  test('decodes settlePayout, its optional providerAmount absent or as a wire string', async () => {
    const server = makeServer();
    const body = (providerAmount?: string) => ({
      kind: 'settlePayout',
      idempotencyKey: 'idem_settle_1',
      actor: { kind: 'operator', operatorId: 'op_1' },
      sagaId: 'pay_missing',
      providerRef: 'prov_1',
      ...(providerAmount === undefined ? {} : { providerAmount }),
    });

    // Both forms clear the decode gate and reach the operation, which answers for the
    // unknown saga — not "Unknown operation kind".
    for (const request of [body(), body('USD:12.34')]) {
      const response = await server(submitRequest(request));
      const payload = (await response.json()) as { title: string };
      assert.equal(response.status, 400);
      assert.match(payload.title, /names a payout that does not exist/);
    }
  });

  test('a non-string providerAmount on settlePayout is refused at the decode gate', async () => {
    const server = makeServer();
    const response = await server(
      submitRequest({
        kind: 'settlePayout',
        idempotencyKey: 'idem_settle_2',
        actor: { kind: 'operator', operatorId: 'op_1' },
        sagaId: 'pay_missing',
        providerRef: 'prov_1',
        providerAmount: 12.34,
      }),
    );
    const payload = (await response.json()) as { title: string };
    assert.equal(response.status, 400);
    assert.match(
      payload.title,
      /'providerAmount' must be an encoded amount string/,
    );
  });

  test('refuses wrong-shaped fields at the decode gate, one uniform 400 each', async () => {
    const server = makeServer();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['idempotencyKey', { ...topUpBody('usr_a', '1.00'), idempotencyKey: '' }],
      ['actor', { ...topUpBody('usr_a', '1.00'), actor: { kind: 'user' } }],
      ['source', { ...topUpBody('usr_a', '1.00'), source: 7 }],
      [
        'periodMs',
        {
          ...spendBody('usr_a', '1.00'),
          kind: 'subscribe',
          userId: 'usr_a',
          sellerId: 'usr_s',
          periodMs: 'soon',
          orderId: undefined,
          buyerId: undefined,
          recipients: undefined,
        },
      ],
      ['recipients', { ...spendBody('usr_a', '1.00'), recipients: 'lol' }],
      [
        'recipients',
        {
          ...spendBody('usr_a', '1.00'),
          recipients: [{ sellerId: '', shareBps: 10_000 }],
        },
      ],
      [
        'ageRestricted',
        { ...spendBody('usr_a', '1.00'), ageRestricted: 'yes' },
      ],
    ];
    for (const [field, body] of cases) {
      const response = await server(submitRequest(body));
      const payload = (await response.json()) as {
        code: string;
        title: string;
      };
      assert.equal(response.status, 400, `${field}: ${payload.title}`);
      assert.equal(payload.code, 'OP.MALFORMED');
      assert.match(payload.title, new RegExp(`'${field}'`));
    }
  });

  test('a field no variant declares is refused, and a required field cannot be absent', async () => {
    const server = makeServer();

    const stray = await server(
      submitRequest({ ...topUpBody('usr_a', '1.00'), giftto: 'usr_b' }),
    );
    assert.equal(stray.status, 400);
    assert.match(
      ((await stray.json()) as { title: string }).title,
      /'giftto' is not part of topUp/,
    );

    const body = topUpBody('usr_a', '1.00');
    delete body.source;
    const missing = await server(submitRequest(body));
    assert.equal(missing.status, 400);
    assert.match(
      ((await missing.json()) as { title: string }).title,
      /'source' must be a non-empty string/,
    );
  });

  test('maps a malformed body to a 400 problem+json with the stable code', async () => {
    const server = makeServer();

    const response = await server(submitRequest({ kind: 'no-such-kind' }));
    const payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 400);
    assert.equal(
      response.headers.get('content-type'),
      'application/problem+json',
    );
    assert.equal(typeof payload.title, 'string');
    assert.equal(payload.status, 400);
    assert.equal(payload.code, 'OP.MALFORMED');
    assert.equal('detail' in payload, false);
    assert.equal('cause' in payload, false);
  });

  test('a thrown EconomyError carrying detail/cause leaks only the problem fields', async () => {
    const economy = {
      submit: async () => {
        throw fault(ERROR_CODES.STORE_FAILURE, 'A storage layer failed.', {
          retryable: true,
          // `owner` is the one detail field any code publishes, and this code is not that code:
          // the allowlist is keyed on the error, so a field name alone opens nothing.
          detail: {
            sql: 'SELECT secret',
            accountId: 'usr_secret',
            owner: 'node-a',
          },
          cause: new Error('connection refused at 10.0.0.5:5432'),
        });
      },
      read: {
        balance: async () => {
          throw new Error('not used');
        },
        statement: async () => {
          throw new Error('not used');
        },
        health: async () => {
          throw new Error('not used');
        },
      },
      close: async () => {},
    } as unknown as Economy;

    const server = makeServer({ economy });

    const response = await server(submitRequest(topUpBody('usr_x', '1.00')));
    const payload = (await response.json()) as Record<string, unknown>;

    // A retryable fault maps to 503.
    assert.equal(response.status, 503);
    assert.equal(payload.title, 'A storage layer failed.');
    assert.deepEqual(Object.keys(payload).sort(), [
      'code',
      'retryable',
      'status',
      'title',
      'type',
    ]);
    assert.equal(payload.code, 'STORE.FAILURE');
    assert.equal(payload.retryable, true);
    assert.equal('detail' in payload, false);
    assert.equal('cause' in payload, false);
    assert.equal('stack' in payload, false);
    assert.equal('owner' in payload, false);
  });

  test('a problem extension cannot overwrite the members the response states', async () => {
    // Extensions carry a field the caller acts on, and RFC 9457 puts them beside `title`, `status`
    // and `type` rather than under them. A name collision therefore has to lose, or an allowlisted
    // field would be able to rewrite the status the mapping just decided.
    const response = problemResponse(
      421,
      'This node does not own the scope.',
      { code: ERROR_CODES.SESSION_MISROUTED, retryable: false },
      {
        owner: 'node-a',
        title: 'overwritten',
        status: 200,
        type: 'about:blank',
        code: 'OP.MALFORMED',
        retryable: true,
      } as never,
    );
    const payload = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 421);
    assert.deepEqual(payload, {
      type: 'https://economy-lab-docs.pages.dev/economy/reference/outcomes-and-reason-codes/',
      title: 'This node does not own the scope.',
      status: 421,
      code: 'SESSION.MISROUTED',
      retryable: false,
      owner: 'node-a',
    });
  });
});

describe('createServer Routing', () => {
  test('returns 404 for an unknown route', async () => {
    const server = makeServer();

    const response = await server(
      new Request('https://economy.test/nope', { method: 'POST' }),
    );

    assert.equal(response.status, 404);
  });
});

describe('createServer /webhooks HMAC Verification', () => {
  test('a correctly-signed body passes through to the handler', async () => {
    const secret = 'sek_test';
    const body = JSON.stringify({ eventId: 'evt_1', amount: '10.00' });
    const signature = await signHex(body, secret);

    let invoked = false;
    const webhook: WebhookHandler = async (_provider, request) => {
      invoked = true;
      // The handler must be able to read the body the server already consumed for verification.
      const received = await request.text();
      assert.equal(received, body);
      return new Response(JSON.stringify({ status: 'committed' }), {
        status: 200,
      });
    };

    const server = makeServer({
      webhook,
      ports: testPorts({ secrets: { webhookSecret: secret } }),
    });

    const response = await server(
      webhookRequest('billing', body, {
        'x-signature': signature,
        'x-timestamp': '0',
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(invoked, true);
  });

  test('a forged signature returns 401 and the handler never runs (no mutation)', async () => {
    const secret = 'sek_test';
    const body = JSON.stringify({ eventId: 'evt_2', amount: '10.00' });
    // Produces a valid-hex but wrong signature by signing with a different secret.
    const forged = await signHex(body, 'wrong-secret');

    let invoked = false;
    const webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(null, { status: 200 });
    };

    const server = makeServer({
      webhook,
      ports: testPorts({ secrets: { webhookSecret: secret } }),
    });

    const response = await server(
      webhookRequest('billing', body, {
        'x-signature': forged,
        'x-timestamp': '0',
      }),
    );
    const payload = (await response.json()) as { title: string };

    assert.equal(response.status, 401);
    assert.equal(invoked, false);
    assert.equal(typeof payload.title, 'string');
    assert.equal('detail' in payload, false);
  });

  test('an absent signature returns 401 and the handler never runs', async () => {
    const secret = 'sek_test';
    const body = JSON.stringify({ eventId: 'evt_3', amount: '10.00' });

    let invoked = false;
    const webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(null, { status: 200 });
    };

    const server = makeServer({
      webhook,
      ports: testPorts({ secrets: { webhookSecret: secret } }),
    });

    const response = await server(
      webhookRequest('billing', body, { 'x-timestamp': '0' }),
    );

    assert.equal(response.status, 401);
    assert.equal(invoked, false);
  });
});

describe('createServer /webhooks Freshness', () => {
  test('a stale timestamp is acknowledged as a duplicate (no mutation)', async () => {
    const secret = 'sek_test';
    const body = JSON.stringify({ eventId: 'evt_4', amount: '10.00' });
    const signature = await signHex(body, secret);
    // Clock is at 0; send a timestamp older than the window so it is out of range.
    const staleTimestamp = -(testConfig().freshnessWindowMs + 1);

    let invoked = false;
    const webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(null, { status: 200 });
    };

    const server = makeServer({
      webhook,
      ports: testPorts({ secrets: { webhookSecret: secret } }),
    });

    const response = await server(
      webhookRequest('billing', body, {
        'x-signature': signature,
        'x-timestamp': String(staleTimestamp),
      }),
    );
    const payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'duplicate');
    assert.equal(invoked, false);
  });

  test('a missing timestamp is treated as non-finite and acknowledged as duplicate', async () => {
    const secret = 'sek_test';
    const body = JSON.stringify({ eventId: 'evt_5', amount: '10.00' });
    const signature = await signHex(body, secret);

    let invoked = false;
    const webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(null, { status: 200 });
    };

    const server = makeServer({
      webhook,
      ports: testPorts({ secrets: { webhookSecret: secret } }),
    });

    const response = await server(
      webhookRequest('billing', body, { 'x-signature': signature }),
    );
    const payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'duplicate');
    assert.equal(invoked, false);
  });

  test('a fresh, signed webhook within the window passes to the handler', async () => {
    const secret = 'sek_test';
    const body = JSON.stringify({ eventId: 'evt_6', amount: '10.00' });
    const signature = await signHex(body, secret);

    let invoked = false;
    const webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(JSON.stringify({ status: 'committed' }), {
        status: 200,
      });
    };

    const server = makeServer({
      webhook,
      ports: testPorts({ secrets: { webhookSecret: secret } }),
    });

    const response = await server(
      webhookRequest('billing', body, {
        'x-signature': signature,
        'x-timestamp': '0',
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(invoked, true);
  });

  // The knob is a bound, so the verdict has to turn over at the value it names. Sending the
  // clock's own time proves the gate is reachable and nothing about where it stops.
  test('the window is inclusive of its own value, and one millisecond past it is not', async () => {
    const secret = 'sek_test';
    const window = testConfig().freshnessWindowMs;

    const deliver = async (skewMs: number): Promise<boolean> => {
      const body = JSON.stringify({ eventId: `evt_edge_${skewMs}` });
      let invoked = false;
      const server = makeServer({
        webhook: async () => {
          invoked = true;
          return new Response(null, { status: 200 });
        },
        ports: testPorts({ secrets: { webhookSecret: secret } }),
      });
      const response = await server(
        webhookRequest('billing', body, {
          'x-signature': await signHex(body, secret),
          'x-timestamp': String(-skewMs),
        }),
      );
      assert.equal(response.status, 200);
      return invoked;
    };

    assert.equal(await deliver(window), true);
    assert.equal(await deliver(window + 1), false);
  });
});

/**
 * `ServerPorts` is a `Pick<Ports, …>`, so a host builds one by hand and it reaches the routes
 * without meeting the bounds check every economy door runs. The knob it decides is the webhook
 * skew window, and a window outside the bound closes the rail while every delivery still answers
 * 200: the status code a correct duplicate also carries. So the assertion below is whether the
 * handler ran, never the status.
 */
describe('createServer webhook window bounds', () => {
  const secret = 'sek_test';

  // The shape decodeWebhookEvent accepts, so the delivery reaches the replay gate and the
  // handler rather than stopping at the codec.
  const eventBody = (eventId: string): string =>
    JSON.stringify({
      eventId,
      userId: 'usr_buyer',
      amount: encodeAmount(credit('10.00')),
      source: 'card',
    });

  // A rail built on one window. `invoked` is what the assertions read: 200 is what a stale
  // delivery, a replayed delivery and an accepted one all answer.
  function railOn(
    config: Config,
    replay?: ReplayStore,
  ): {
    invoked: () => boolean;
    deliverFresh: (eventId: string) => Promise<string>;
  } {
    let seen = false;
    const server = createServer({
      economy: makeEconomy(),
      authenticate: false,
      webhook: async () => {
        seen = true;
        return new Response(JSON.stringify({ status: 'accepted' }), {
          status: 200,
        });
      },
      ports: testPorts({ config, secrets: { webhookSecret: secret } }),
      ...(replay === undefined ? {} : { replay }),
    });
    return {
      invoked: () => seen,
      deliverFresh: async (eventId) => {
        const body = eventBody(eventId);
        // The clock is fixed at 0 and so is the timestamp: zero skew, inside any sane window.
        const response = await server(
          webhookRequest('billing', body, {
            'x-signature': await signHex(body, secret),
            'x-timestamp': '0',
          }),
        );
        assert.equal(response.status, 200);
        return ((await response.json()) as { status?: string }).status ?? '';
      },
    };
  }

  test('a window outside the bound cannot serve, because every delivery under it answers 200 duplicate', async () => {
    const config: Config = { ...testConfig(), freshnessWindowMs: -1 };
    let served: ReturnType<typeof railOn> | undefined;
    let refusal: Error | undefined;
    try {
      served = railOn(config);
    } catch (error) {
      refusal = error as Error;
    }

    if (served !== undefined) {
      // Reached only while the door still constructs. A negative window makes `Math.abs(now -
      // timestamp) > window` true for every timestamp, so a delivery with no skew at all reads as
      // stale and is acknowledged; the provider stops redelivering and the rail goes quiet.
      const status = await served.deliverFresh('evt_bad_window');
      assert.deepEqual(
        { status, invoked: served.invoked() },
        { status: 'accepted', invoked: true },
        'createServer served on freshnessWindowMs: -1 and the fresh delivery never reached the handler',
      );
    }

    assert.ok(refusal, 'createServer served on freshnessWindowMs: -1');
    assert.equal(
      (refusal as { code?: string }).code,
      'CONFIG.INVALID',
      `the refusal carries the config fault code; it said "${refusal.message}"`,
    );
    assert.ok(
      refusal.message.includes(WINDOW_FRAGMENT),
      `the refusal has to hand over "${WINDOW_FRAGMENT}"; it said "${refusal.message}"`,
    );
  });

  // Without this, "a bad window is refused" is satisfied by a server that refuses every window,
  // and "the handler ran" is satisfied by a rail that stopped dedupping.
  test('a window inside the bound still takes a fresh delivery and still answers duplicate to a real replay', async () => {
    const seen = new Set<string>();
    const rail = railOn({ ...testConfig(), freshnessWindowMs: 30_000 }, {
      claim: async (eventId: string) => {
        const claimed = !seen.has(eventId);
        seen.add(eventId);
        return { claimed };
      },
    } satisfies ReplayStore);

    assert.equal(await rail.deliverFresh('evt_good_window'), 'accepted');
    assert.equal(rail.invoked(), true);
    // The same event id a second time: this is the 200 duplicate that is supposed to happen.
    assert.equal(await rail.deliverFresh('evt_good_window'), 'duplicate');
  });
});

describe('createServer /webhooks Duplicate Metering', () => {
  test('each duplicate acknowledgement counts once, tagged with the layer that caught it', async () => {
    const secret = 'sek_test';
    const body = JSON.stringify({
      eventId: 'evt_dup',
      userId: 'usr_buyer',
      amount: encodeAmount(credit('10.00')),
      source: 'card',
    });
    const signature = await signHex(body, secret);
    const counts: Array<{ name: string; tags?: Record<string, string> }> = [];
    const meter = {
      count: (name: string, _n: number, tags?: Record<string, string>) =>
        counts.push({ name, tags }),
      observe: () => {},
    };
    const seen = new Set<string>();
    const server = makeServer({
      webhook: async () =>
        new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }),
      ports: testPorts({ secrets: { webhookSecret: secret }, meter }),
      replay: {
        claim: async (eventId: string) => {
          const claimed = !seen.has(eventId);
          seen.add(eventId);
          return { claimed };
        },
      },
    });
    const deliver = (timestamp: string): Promise<Response> =>
      server(
        webhookRequest('billing', body, {
          'x-signature': signature,
          'x-timestamp': timestamp,
        }),
      );

    // First sighting: accepted, nothing counted.
    const first = await deliver('0');
    assert.equal(first.status, 200);
    assert.equal(counts.length, 0);

    // Redelivery of a seen eventId: the replay gate catches it.
    const second = await deliver('0');
    assert.equal(
      ((await second.json()) as { status: string }).status,
      'duplicate',
    );
    assert.deepEqual(
      [...counts],
      [
        {
          name: 'economy.webhook.duplicate',
          tags: { provider: 'billing', layer: 'replay' },
        },
      ],
    );

    // A stale timestamp never reaches the replay gate; freshness catches it first.
    const stale = String(-(testConfig().freshnessWindowMs + 1));
    await deliver(stale);
    assert.equal(counts.length, 2);
    assert.deepEqual(counts[1]?.tags, { provider: 'billing', layer: 'stale' });
  });
});

describe('createServer Health And Readiness', () => {
  test('GET /healthz returns 200 without touching the store', async () => {
    const server = makeServer();

    const response = await server(
      new Request('https://economy.test/healthz', { method: 'GET' }),
    );
    const payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ok');
  });

  test('GET /readyz returns 200 when the store read succeeds', async () => {
    const server = makeServer();

    const response = await server(
      new Request('https://economy.test/readyz', { method: 'GET' }),
    );
    const payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ready');
  });

  test('GET /readyz returns 503 when the store read throws', async () => {
    // read.balance is the readiness probe, so only it needs to be real.
    const economy = {
      submit: async () => {
        throw new Error('not used');
      },
      read: {
        balance: async () => {
          throw new Error('store unreachable');
        },
        statement: async () => {
          throw new Error('not used');
        },
        health: async () => {
          throw new Error('not used');
        },
      },
      close: async () => {},
    } as unknown as Economy;

    const server = makeServer({ economy });

    const response = await server(
      new Request('https://economy.test/readyz', { method: 'GET' }),
    );
    const payload = (await response.json()) as { status: string };

    assert.equal(response.status, 503);
    assert.equal(payload.status, 'unavailable');
  });
});

describe('createServer /submit Authentication', () => {
  test('stamps the authenticated principal as the actor', async () => {
    const server = makeServer({
      authenticate: async () => ({ kind: 'system', service: 'gateway' }),
    });

    const response = await server(
      submitRequest({
        kind: 'topUp',
        idempotencyKey: 'idem_auth_stamp',
        userId: 'usr_auth',
        source: 'card',
        amount: encodeAmount(credit('10.00')),
      }),
    );
    const payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'committed');
  });

  test('returns a 401 problem when the hook refuses the request', async () => {
    const server = makeServer({
      authenticate: async () => null,
    });

    const response = await server(
      submitRequest(topUpBody('usr_denied', '1.00')),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 401);
    assert.equal(
      response.headers.get('content-type'),
      'application/problem+json',
    );
    assert.equal(payload.code, ERROR_CODES.UNAUTHORIZED);
  });

  test('rejects an authenticated body that carries its own actor', async () => {
    const server = makeServer({
      authenticate: async () => ({ kind: 'system', service: 'gateway' }),
    });

    const response = await server(
      submitRequest(topUpBody('usr_spoof', '1.00')),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 400);
    assert.equal(payload.code, ERROR_CODES.MALFORMED_OPERATION);
  });

  test('trusts the body actor when authenticate is explicitly false', async () => {
    const server = makeServer({ authenticate: false });

    const response = await server(
      submitRequest(topUpBody('usr_inproc', '1.00')),
    );
    const payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'committed');
  });

  test('omitting authenticate refuses to construct with CONFIG.INVALID', () => {
    assert.throws(
      () => createServer({ economy: makeEconomy(), ports: testPorts() }),
      hasCode('CONFIG.INVALID'),
    );
  });
});

describe('createServer Body Limits', () => {
  test('returns a 413 problem past the byte ceiling', async () => {
    const server = makeServer({ maxBodyBytes: 64 });

    const body = topUpBody('usr_big', '10.00');
    body.memo = 'x'.repeat(256);
    const response = await server(submitRequest(body));

    assert.equal(response.status, 413);
    assert.equal(
      response.headers.get('content-type'),
      'application/problem+json',
    );
  });

  test('returns a 408 problem when the body read passes the deadline', async () => {
    const server = makeServer({ readTimeoutMs: 20 });

    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const request = new Request('https://economy.test/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stalled,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    // The deadline rides an unref'ed timer; a live server has sockets holding the loop open,
    // but here a ref'ed keepalive must stand in for them or the process drains first.
    const keepalive = setTimeout(() => {}, 5_000);
    const response = await server(request);
    clearTimeout(keepalive);

    assert.equal(response.status, 408);
  });

  test('caps the webhook body under the same ceiling', async () => {
    const server = makeServer({
      webhook: (async () => new Response('ok')) as WebhookHandler,
      maxBodyBytes: 64,
    });

    const response = await server(
      webhookRequest('tilia', JSON.stringify({ pad: 'x'.repeat(256) })),
    );

    assert.equal(response.status, 413);
  });

  // The reader is exported because a package that has to bound a read before it authenticates
  // cannot reach a module-private one. It answers a verdict rather than throwing, so the lab's
  // routes keep their 413/408 and a caller that refuses differently keeps its own shape.
  test('readBounded answers a verdict for each of the three outcomes', async () => {
    const bodied = (body: string) =>
      new Request('https://economy.test/submit', { method: 'POST', body });

    assert.deepEqual(await readBounded(bodied('hello')), {
      status: 'read',
      bytes: new TextEncoder().encode('hello'),
    });

    assert.deepEqual(await readBounded(bodied('hello'), { maxBytes: 2 }), {
      status: 'oversize',
    });

    const stalled = new Request('https://economy.test/submit', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({ start() {} }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const keepalive = setTimeout(() => {}, 5_000);
    assert.deepEqual(await readBounded(stalled, { timeoutMs: 20 }), {
      status: 'timeout',
    });
    clearTimeout(keepalive);
  });

  test('readBounded refuses a lying content-length by counting', async () => {
    const request = new Request('https://economy.test/submit', {
      method: 'POST',
      headers: { 'content-length': '2' },
      body: 'x'.repeat(256),
    });

    assert.deepEqual(await readBounded(request, { maxBytes: 8 }), {
      status: 'oversize',
    });
  });
});

describe('createServer CORS', () => {
  const allowlisted = { cors: { origins: ['https://app.example'] } };

  test('sets no CORS headers when the option is absent', async () => {
    const server = makeServer();

    const response = await server(
      new Request('https://economy.test/healthz', {
        headers: { origin: 'https://app.example' },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('grants a preflight from an allowlisted origin', async () => {
    const server = makeServer(allowlisted);

    const response = await server(
      new Request('https://economy.test/submit', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      }),
    );

    assert.equal(response.status, 204);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'https://app.example',
    );
    assert.equal(
      response.headers.get('access-control-allow-headers'),
      'content-type',
    );
  });

  test('answers a preflight from an unlisted origin with no grant', async () => {
    const server = makeServer(allowlisted);

    const response = await server(
      new Request('https://economy.test/submit', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
        },
      }),
    );

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('rides the grant on route responses for an allowlisted origin', async () => {
    const server = makeServer(allowlisted);

    const response = await server(
      new Request('https://economy.test/healthz', {
        headers: { origin: 'https://app.example' },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'https://app.example',
    );
    assert.equal(response.headers.get('vary'), 'origin');
  });
});

describe('createServer Rate Limiting', () => {
  test('answers 429 with retry-after when the limiter denies', async () => {
    const server = makeServer({
      rateLimit: {
        limiter: {
          allow: async () => ({ allowed: false, retryAfterMs: 1_500 }),
        },
      },
    });

    const response = await server(
      submitRequest(topUpBody('usr_limited', '1.00')),
    );

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '2');
    assert.equal(
      response.headers.get('content-type'),
      'application/problem+json',
    );
  });

  test('keys by the authenticated principal', async () => {
    const keys: string[] = [];
    const server = makeServer({
      authenticate: async () => ({ kind: 'user', userId: 'usr_keyed' }),
      rateLimit: {
        limiter: {
          allow: async (key) => {
            keys.push(key);
            return { allowed: true };
          },
        },
      },
    });

    await server(
      submitRequest({
        kind: 'topUp',
        idempotencyKey: 'idem_rate_key',
        userId: 'usr_keyed',
        source: 'card',
        amount: encodeAmount(credit('1.00')),
      }),
    );

    assert.deepEqual(keys, ['user:usr_keyed']);
  });

  test('falls back to the stamped client address without a principal', async () => {
    const keys: string[] = [];
    const server = makeServer({
      rateLimit: {
        limiter: {
          allow: async (key) => {
            keys.push(key);
            return { allowed: true };
          },
        },
      },
    });

    await server(
      new Request('https://economy.test/submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-economy-client-ip': '10.0.0.9',
        },
        body: JSON.stringify(topUpBody('usr_ip', '1.00')),
      }),
    );

    assert.deepEqual(keys, ['ip:10.0.0.9']);
  });

  test('a throwing limiter fails open and counts degraded', async () => {
    const counted: string[] = [];
    const server = makeServer({
      ports: testPorts({
        meter: {
          count: (name) => {
            counted.push(name);
          },
          observe: () => {},
        },
      }),
      rateLimit: {
        limiter: {
          allow: async () => {
            throw new Error('limiter backend down');
          },
        },
      },
    });

    const response = await server(submitRequest(topUpBody('usr_open', '1.00')));
    const payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'committed');
    assert.equal(counted.includes('economy.ratelimit.degraded'), true);
  });

  // A key that cannot tell two callers apart is not admission control. Behind a proxy the
  // peer address is the proxy on every request, so the default pools; the caller's own
  // address is on the request the whole time, in a header only the host knows how to read.
  // Nothing here trusts that header — it is read as evidence that the deployment is proxied
  // and counted, never keyed on.

  // Records every count with its tags, so a test can name the reason and not just the event.
  function countingServer(options: Partial<ServerOptions> = {}): {
    handler: FetchHandler;
    counted: { name: string; tags?: Record<string, string> }[];
    keys: string[];
  } {
    const counted: { name: string; tags?: Record<string, string> }[] = [];
    const keys: string[] = [];
    const handler = makeServer({
      ports: testPorts({
        meter: {
          count: (name, _n, tags) => {
            counted.push({ name, tags });
          },
          observe: () => {},
        },
      }),
      rateLimit: {
        limiter: {
          allow: async (key) => {
            keys.push(key);
            return { allowed: true };
          },
        },
      },
      ...options,
    });
    return { handler, counted, keys };
  }

  const pooled = (
    counted: { name: string; tags?: Record<string, string> }[],
  ): (string | undefined)[] =>
    counted
      .filter((c) => c.name === 'economy.ratelimit.pooled')
      .map((c) => c.tags?.reason);

  function ipRequest(headers: Record<string, string>): Request {
    return new Request('https://economy.test/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(topUpBody('usr_pool', '1.00')),
    });
  }

  test('principalKey tells two callers of one kind apart', () => {
    assert.notEqual(
      principalKey({ kind: 'user', userId: 'usr_alice' }),
      principalKey({ kind: 'user', userId: 'usr_bob' }),
    );
    assert.deepEqual(
      [
        principalKey({ kind: 'user', userId: 'usr_alice' }),
        principalKey({ kind: 'system', service: 'checkout' }),
        principalKey({ kind: 'operator', operatorId: 'op_7' }),
      ],
      ['user:usr_alice', 'system:checkout', 'operator:op_7'],
    );
  });

  test('a proxied request counts pooled and still keys on the peer', async () => {
    const { handler, counted, keys } = countingServer();

    await handler(
      ipRequest({
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'x-economy-client-ip': '10.0.0.1',
      }),
    );

    assert.deepEqual(pooled(counted), ['forwarded']);
    assert.deepEqual(keys, ['ip:10.0.0.1']);
  });

  test('every forwarding header in the roster is evidence, and only those', async () => {
    const roster = [
      'forwarded',
      'x-forwarded-for',
      'x-real-ip',
      'cf-connecting-ip',
      'true-client-ip',
    ];
    const seen: string[] = [];
    for (const header of roster) {
      const { handler, counted } = countingServer();
      await handler(
        ipRequest({
          [header]: '203.0.113.7',
          'x-economy-client-ip': '10.0.0.1',
        }),
      );
      if (pooled(counted).length === 1) seen.push(header);
    }
    assert.deepEqual(seen, roster);

    // A header that says nothing about a hop is not evidence of one.
    const plain = countingServer();
    await plain.handler(
      ipRequest({ 'x-request-id': 'req_1', 'x-economy-client-ip': '10.0.0.1' }),
    );
    assert.deepEqual(pooled(plain.counted), []);
  });

  test('an unstamped request counts pooled as unstamped', async () => {
    const { handler, counted, keys } = countingServer();

    await handler(ipRequest({}));

    assert.deepEqual(pooled(counted), ['unstamped']);
    assert.deepEqual(keys, ['ip:unknown']);
  });

  test('a directly connected caller counts nothing', async () => {
    const { handler, counted, keys } = countingServer();

    await handler(ipRequest({ 'x-economy-client-ip': '203.0.113.7' }));

    assert.deepEqual(pooled(counted), []);
    assert.deepEqual(keys, ['ip:203.0.113.7']);
  });

  test('an authenticated caller behind a proxy counts nothing', async () => {
    const { handler, counted, keys } = countingServer({
      authenticate: async () => ({ kind: 'user', userId: 'usr_keyed' }),
    });

    await handler(
      ipRequest({
        'x-forwarded-for': '203.0.113.7',
        'x-economy-client-ip': '10.0.0.1',
      }),
    );

    assert.deepEqual(pooled(counted), []);
    assert.deepEqual(keys, ['user:usr_keyed']);
  });

  // The recipe the TSDoc prints, and the reason principalKey is exported: a host keying on
  // its own forwarded address must not have to re-derive the principal half to do it.
  test('a host that supplied keyFor keys on the caller and counts nothing', async () => {
    const own: string[] = [];
    const { handler, counted } = countingServer({
      rateLimit: {
        limiter: {
          allow: async (key) => {
            own.push(key);
            return { allowed: true };
          },
        },
        keyFor: (request, principal) =>
          principal === undefined
            ? `ip:${request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'}`
            : principalKey(principal),
      },
    });

    await handler(
      ipRequest({
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'x-economy-client-ip': '10.0.0.1',
      }),
    );

    assert.deepEqual(own, ['ip:203.0.113.7']);
    assert.deepEqual(pooled(counted), []);
  });
});

describe('createServer Correlation', () => {
  test('mints a request id and echoes it on the submit response', async () => {
    const server = makeServer();

    const response = await server(
      submitRequest(topUpBody('usr_corr_mint', '1.00')),
    );

    assert.match(response.headers.get('x-request-id') ?? '', /^req_/);
  });

  test('echoes a caller-supplied x-request-id', async () => {
    const server = makeServer();

    const request = new Request('https://economy.test/submit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req_caller_1',
      },
      body: JSON.stringify(topUpBody('usr_corr_echo', '1.00')),
    });
    const response = await server(request);

    assert.equal(response.headers.get('x-request-id'), 'req_caller_1');
  });

  test('a traceparent trace id wins over x-request-id', async () => {
    const server = makeServer();
    const traceId = 'ab'.repeat(16);

    const request = new Request('https://economy.test/submit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        traceparent: `00-${traceId}-${'cd'.repeat(8)}-01`,
        'x-request-id': 'req_loser',
      },
      body: JSON.stringify(topUpBody('usr_corr_trace', '1.00')),
    });
    const response = await server(request);

    assert.equal(response.headers.get('x-request-id'), traceId);
  });

  test('a malformed supplied id is replaced, and problems still echo', async () => {
    const server = makeServer({
      authenticate: async () => null,
    });

    const request = new Request('https://economy.test/submit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'bad id with spaces',
      },
      body: JSON.stringify(topUpBody('usr_corr_bad', '1.00')),
    });
    const response = await server(request);

    assert.equal(response.status, 401);
    assert.match(response.headers.get('x-request-id') ?? '', /^req_/);
  });
});
