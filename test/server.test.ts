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

import { createServer } from '#src/server.ts';
import { encodeAmount } from '#src/money.ts';
import { toHex } from '#src/bytes.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { credit } from '#test/support/builders.ts';
import { fixedClock, testConfig } from '#test/support/capabilities.ts';

import type { Economy } from '#src/contract.ts';
import type { WebhookHandler } from '#src/server.ts';

// Lowercase hex HMAC-SHA256 over the body — the form the `x-signature` header carries.
async function signHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  return toHex(new Uint8Array(signature));
}

function webhookRequest(
  provider: string,
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://economy.test/webhooks/${provider}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
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
    const server = createServer(makeEconomy());

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
    const server = createServer(makeEconomy());

    const response = await server(
      submitRequest(spendBody('usr_broke', '5.00')),
    );
    const payload = (await response.json()) as {
      status: string;
      reason: string;
      detail?: { required?: unknown; available?: unknown };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'rejected');
    assert.equal(payload.reason, 'INSUFFICIENT_FUNDS');
    // Detail Amounts ride the wire as the same decimal strings every other amount uses.
    assert.equal(payload.detail?.required, 'CREDIT:5.00');
    assert.equal(payload.detail?.available, 'CREDIT:0.00');
  });

  test('decodes settlePayout, its optional providerAmount absent or as a wire string', async () => {
    const server = createServer(makeEconomy());
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
    const server = createServer(makeEconomy());
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
    const server = createServer(makeEconomy());
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
    const server = createServer(makeEconomy());

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
    const server = createServer(makeEconomy());

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
          detail: { sql: 'SELECT secret', accountId: 'usr_secret' },
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
        prove: async () => {
          throw new Error('not used');
        },
      },
      close: async () => {},
    } as unknown as Economy;

    const server = createServer(economy);

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
  });
});

describe('createServer Routing', () => {
  test('returns 404 for an unknown route', async () => {
    const server = createServer(makeEconomy());

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

    const server = createServer(makeEconomy(), {
      webhook,
      config: { ...testConfig(), webhookSecret: secret },
      clock: fixedClock(0),
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

    const server = createServer(makeEconomy(), {
      webhook,
      config: { ...testConfig(), webhookSecret: secret },
      clock: fixedClock(0),
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

    const server = createServer(makeEconomy(), {
      webhook,
      config: { ...testConfig(), webhookSecret: secret },
      clock: fixedClock(0),
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
    const config = { ...testConfig(), webhookSecret: secret };
    // Clock is at 0; send a timestamp older than the window so it is out of range.
    const staleTimestamp = -(config.replayWindowMs + 1);

    let invoked = false;
    const webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(null, { status: 200 });
    };

    const server = createServer(makeEconomy(), {
      webhook,
      config,
      clock: fixedClock(0),
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

    const server = createServer(makeEconomy(), {
      webhook,
      config: { ...testConfig(), webhookSecret: secret },
      clock: fixedClock(0),
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

    const server = createServer(makeEconomy(), {
      webhook,
      config: { ...testConfig(), webhookSecret: secret },
      clock: fixedClock(0),
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
});

describe('createServer Health And Readiness', () => {
  test('GET /healthz returns 200 without touching the store', async () => {
    const server = createServer(makeEconomy());

    const response = await server(
      new Request('https://economy.test/healthz', { method: 'GET' }),
    );
    const payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ok');
  });

  test('GET /readyz returns 200 when the store read succeeds', async () => {
    const server = createServer(makeEconomy());

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
        prove: async () => {
          throw new Error('not used');
        },
      },
      close: async () => {},
    } as unknown as Economy;

    const server = createServer(economy);

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
    const server = createServer(makeEconomy(), {
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
    const server = createServer(makeEconomy(), {
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
    const server = createServer(makeEconomy(), {
      authenticate: async () => ({ kind: 'system', service: 'gateway' }),
    });

    const response = await server(
      submitRequest(topUpBody('usr_spoof', '1.00')),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 400);
    assert.equal(payload.code, ERROR_CODES.MALFORMED_OPERATION);
  });

  test('trusts the body actor when no hook is configured', async () => {
    const server = createServer(makeEconomy());

    const response = await server(
      submitRequest(topUpBody('usr_inproc', '1.00')),
    );
    const payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'committed');
  });
});

describe('createServer Body Limits', () => {
  test('returns a 413 problem past the byte ceiling', async () => {
    const server = createServer(makeEconomy(), { maxBodyBytes: 64 });

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
    const server = createServer(makeEconomy(), { readTimeoutMs: 20 });

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
    const server = createServer(makeEconomy(), {
      webhook: (async () => new Response('ok')) as WebhookHandler,
      maxBodyBytes: 64,
    });

    const response = await server(
      webhookRequest('tilia', JSON.stringify({ pad: 'x'.repeat(256) })),
    );

    assert.equal(response.status, 413);
  });
});

describe('createServer CORS', () => {
  const allowlisted = { cors: { origins: ['https://app.example'] } };

  test('sets no CORS headers when the option is absent', async () => {
    const server = createServer(makeEconomy());

    const response = await server(
      new Request('https://economy.test/healthz', {
        headers: { origin: 'https://app.example' },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('grants a preflight from an allowlisted origin', async () => {
    const server = createServer(makeEconomy(), allowlisted);

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
    const server = createServer(makeEconomy(), allowlisted);

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
    const server = createServer(makeEconomy(), allowlisted);

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
    const server = createServer(makeEconomy(), {
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
    const server = createServer(makeEconomy(), {
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
    const server = createServer(makeEconomy(), {
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
    const server = createServer(makeEconomy(), {
      meter: {
        count: (name) => {
          counted.push(name);
        },
        observe: () => {},
      },
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
});

describe('createServer Correlation', () => {
  test('mints a request id and echoes it on the submit response', async () => {
    const server = createServer(makeEconomy());

    const response = await server(
      submitRequest(topUpBody('usr_corr_mint', '1.00')),
    );

    assert.match(response.headers.get('x-request-id') ?? '', /^req_/);
  });

  test('echoes a caller-supplied x-request-id', async () => {
    const server = createServer(makeEconomy());

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
    const server = createServer(makeEconomy());
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
    const server = createServer(makeEconomy(), {
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
