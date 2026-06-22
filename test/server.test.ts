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

// Sign raw bytes with HMAC-SHA256 under `secret` and return the lowercase hex digest, exactly the
// form the server expects in the `x-signature` header. Uses Web Crypto so the test runs unchanged
// on every target runtime.
async function signHex(body: string, secret: string): Promise<string> {
  let key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  let signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  return toHex(new Uint8Array(signature));
}

// Build a POST request to a webhook endpoint with an optional signature and timestamp header, so a
// test can send a correctly-signed, forged, or stale callback.
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

// Build a POST request to the server's /submit endpoint from an operation body. The body's
// money fields must already be encoded as decimal strings (the form the server decodes),
// since that is exactly what a real client would put on the wire.
function submitRequest(body: Record<string, unknown>): Request {
  return new Request('https://economy.test/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A "add money to a user's balance" (topUp) request body. Only `amount` is encoded as a
// decimal string (the one money field the server decodes); every other field is plain JSON,
// just as a client would serialize it.
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

// A "buy something" (spend) request body for a buyer who has never added money. With no
// balance, the server checks up front and returns a normal "no" (a rejected outcome with
// reason INSUFFICIENT_FUNDS) instead of treating it as a server error.
function spendBody(buyerId: string, dollars: string): Record<string, unknown> {
  return {
    kind: 'spend',
    idempotencyKey: `idem_spend_${buyerId}`,
    actor: { kind: 'user', userId: buyerId },
    orderId: `ord_${buyerId}`,
    buyerId,
    sku: 'sku_demo',
    price: encodeAmount(credit(dollars)),
  };
}

describe('createServer /submit', () => {
  test('commits a valid operation and returns 200 with the encoded transaction', async () => {
    let server = createServer(makeEconomy());

    let response = await server(submitRequest(topUpBody('usr_buyer', '10.00')));
    let payload = (await response.json()) as {
      status: string;
      transaction: { legs: Array<{ account: string; amount: string }> };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'committed');
    // Each line of the transaction reports its amount as a decimal string like
    // 'CREDIT:10.00' (currency, then dollars), so no raw integer ever crosses the wire.
    assert.equal(
      payload.transaction.legs.some((leg) => leg.amount === 'CREDIT:10.00'),
      true,
    );
  });

  test('returns 200 with the rejected Outcome for a valid decline', async () => {
    let server = createServer(makeEconomy());

    let response = await server(submitRequest(spendBody('usr_broke', '5.00')));
    let payload = (await response.json()) as { status: string; reason: string };

    // Declining a valid request (here, not enough money) is a normal result, not a server
    // error: the server answers 200 and the body says why it was rejected.
    assert.equal(response.status, 200);
    assert.equal(payload.status, 'rejected');
    assert.equal(payload.reason, 'INSUFFICIENT_FUNDS');
  });

  test('maps a malformed body to 400 surfacing only the message', async () => {
    let server = createServer(makeEconomy());

    let response = await server(submitRequest({ kind: 'no-such-kind' }));
    let payload = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 400);
    assert.equal(typeof payload.error, 'string');
    // The error response carries only the human-readable message. Internal fields such as
    // `detail` or `cause` are kept server-side so they never leak to the client.
    assert.equal('detail' in payload, false);
    assert.equal('cause' in payload, false);
  });

  test('a thrown EconomyError carrying detail/cause leaks only { error: message }', async () => {
    // A submit that faults with a richly-populated EconomyError — internal detail, an
    // underlying cause, and the implicit stack. The boundary must surface none of them.
    let economy = {
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

    let server = createServer(economy);

    let response = await server(submitRequest(topUpBody('usr_x', '1.00')));
    let payload = (await response.json()) as Record<string, unknown>;

    // Retryable fault → 503, but the body is just the human-readable message.
    assert.equal(response.status, 503);
    assert.equal(payload.error, 'A storage layer failed.');
    // The body has exactly one key — no detail, cause, or stack rode along.
    assert.deepEqual(Object.keys(payload), ['error']);
    assert.equal('detail' in payload, false);
    assert.equal('cause' in payload, false);
    assert.equal('stack' in payload, false);
  });
});

describe('createServer Routing', () => {
  test('returns 404 for an unknown route', async () => {
    let server = createServer(makeEconomy());

    let response = await server(
      new Request('https://economy.test/nope', { method: 'POST' }),
    );

    assert.equal(response.status, 404);
  });
});

describe('createServer /webhooks HMAC Verification', () => {
  test('a correctly-signed body passes through to the handler', async () => {
    let secret = 'sek_test';
    let body = JSON.stringify({ eventId: 'evt_1', amount: '10.00' });
    let signature = await signHex(body, secret);

    let invoked = false;
    let webhook: WebhookHandler = async (_provider, request) => {
      invoked = true;
      // The handler must be able to read the body the server already consumed for verification.
      let received = await request.text();
      assert.equal(received, body);
      return new Response(JSON.stringify({ status: 'committed' }), {
        status: 200,
      });
    };

    let server = createServer(makeEconomy(), {
      webhook,
      config: { ...testConfig(), webhookSecret: secret },
      clock: fixedClock(0),
    });

    let response = await server(
      webhookRequest('billing', body, {
        'x-signature': signature,
        'x-timestamp': '0',
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(invoked, true);
  });

  test('a forged signature returns 401 and the handler never runs (no mutation)', async () => {
    let secret = 'sek_test';
    let body = JSON.stringify({ eventId: 'evt_2', amount: '10.00' });
    // A valid-hex but wrong signature: signed with a different secret.
    let forged = await signHex(body, 'wrong-secret');

    let invoked = false;
    let webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(null, { status: 200 });
    };

    let server = createServer(makeEconomy(), {
      webhook,
      config: { ...testConfig(), webhookSecret: secret },
      clock: fixedClock(0),
    });

    let response = await server(
      webhookRequest('billing', body, {
        'x-signature': forged,
        'x-timestamp': '0',
      }),
    );
    let payload = (await response.json()) as { error: string };

    assert.equal(response.status, 401);
    // The handler — the only thing that would mutate the ledger — was never reached.
    assert.equal(invoked, false);
    // Only the human-readable message escapes; internal detail stays server-side.
    assert.equal(typeof payload.error, 'string');
    assert.equal('detail' in payload, false);
  });

  test('an absent signature returns 401 and the handler never runs', async () => {
    let secret = 'sek_test';
    let body = JSON.stringify({ eventId: 'evt_3', amount: '10.00' });

    let invoked = false;
    let webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(null, { status: 200 });
    };

    let server = createServer(makeEconomy(), {
      webhook,
      config: { ...testConfig(), webhookSecret: secret },
      clock: fixedClock(0),
    });

    let response = await server(
      webhookRequest('billing', body, { 'x-timestamp': '0' }),
    );

    assert.equal(response.status, 401);
    assert.equal(invoked, false);
  });
});

describe('createServer /webhooks Freshness', () => {
  test('a stale timestamp is acknowledged as a duplicate (no mutation)', async () => {
    let secret = 'sek_test';
    let body = JSON.stringify({ eventId: 'evt_4', amount: '10.00' });
    let signature = await signHex(body, secret);
    let config = { ...testConfig(), webhookSecret: secret };
    // Clock is at 0; send a timestamp older than the window so it is out of range.
    let staleTimestamp = -(config.replayWindowMs + 1);

    let invoked = false;
    let webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(null, { status: 200 });
    };

    let server = createServer(makeEconomy(), {
      webhook,
      config,
      clock: fixedClock(0),
    });

    let response = await server(
      webhookRequest('billing', body, {
        'x-signature': signature,
        'x-timestamp': String(staleTimestamp),
      }),
    );
    let payload = (await response.json()) as { status: string };

    // A request that arrives too late to be fresh is treated like a repeat that was already
    // handled: the server answers 200 with status 'duplicate' and changes nothing.
    assert.equal(response.status, 200);
    assert.equal(payload.status, 'duplicate');
    assert.equal(invoked, false);
  });

  test('a missing timestamp is treated as non-finite and acknowledged as duplicate', async () => {
    let secret = 'sek_test';
    let body = JSON.stringify({ eventId: 'evt_5', amount: '10.00' });
    let signature = await signHex(body, secret);

    let invoked = false;
    let webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(null, { status: 200 });
    };

    let server = createServer(makeEconomy(), {
      webhook,
      config: { ...testConfig(), webhookSecret: secret },
      clock: fixedClock(0),
    });

    let response = await server(
      webhookRequest('billing', body, { 'x-signature': signature }),
    );
    let payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'duplicate');
    assert.equal(invoked, false);
  });

  test('a fresh, signed webhook within the window passes to the handler', async () => {
    let secret = 'sek_test';
    let body = JSON.stringify({ eventId: 'evt_6', amount: '10.00' });
    let signature = await signHex(body, secret);

    let invoked = false;
    let webhook: WebhookHandler = async () => {
      invoked = true;
      return new Response(JSON.stringify({ status: 'committed' }), {
        status: 200,
      });
    };

    let server = createServer(makeEconomy(), {
      webhook,
      config: { ...testConfig(), webhookSecret: secret },
      clock: fixedClock(0),
    });

    let response = await server(
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
    let server = createServer(makeEconomy());

    let response = await server(
      new Request('https://economy.test/healthz', { method: 'GET' }),
    );
    let payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ok');
  });

  test('GET /readyz returns 200 when the store read succeeds', async () => {
    let server = createServer(makeEconomy());

    let response = await server(
      new Request('https://economy.test/readyz', { method: 'GET' }),
    );
    let payload = (await response.json()) as { status: string };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ready');
  });

  test('GET /readyz returns 503 when the store read throws', async () => {
    // A minimal economy whose readiness probe (read.balance) fails, standing in for an
    // unreachable store. Only the surface /readyz touches needs to be real.
    let economy = {
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

    let server = createServer(economy);

    let response = await server(
      new Request('https://economy.test/readyz', { method: 'GET' }),
    );
    let payload = (await response.json()) as { status: string };

    assert.equal(response.status, 503);
    assert.equal(payload.status, 'unavailable');
  });
});
