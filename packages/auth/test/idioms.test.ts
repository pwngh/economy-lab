/**
 * @pwngh/economy-auth
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
  bearerStack,
  authApiKeys,
  devAuthenticate,
  devTokens,
  systemActor,
  userActor,
} from '../src/index.js';
import { CLIENT_IP_HEADER } from '@pwngh/economy-lab/server';

test('bearerStack: first principal wins, nulls fall through, non-functions refuse at construction', async () => {
  const stack = bearerStack(
    authApiKeys({ sk_a: systemActor('a') }),
    authApiKeys({ sk_b: systemActor('b') }),
  );
  const ask = (token: string) =>
    stack(
      new Request('http://t/', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  assert.deepEqual(await ask('sk_a'), systemActor('a'));
  assert.deepEqual(
    await ask('sk_b'),
    systemActor('b'),
    'a null falls through to the tail',
  );
  assert.equal(await ask('sk_c'), null);
  assert.throws(
    () => bearerStack(authApiKeys({}), 'jwks' as never),
    /element 2/,
  );
});

test('devTokens.loopbackOnly: answers dev tokens on loopback outside production, inert otherwise', async () => {
  const auth = devTokens.loopbackOnly();
  const ask = (headers: Record<string, string>) =>
    auth(new Request('http://t/', { headers }));
  const bearer = { authorization: 'Bearer dev_user_ada' };

  assert.deepEqual(
    await ask({ ...bearer, [CLIENT_IP_HEADER]: '127.0.0.1' }),
    userActor('usr_ada'),
  );
  assert.equal(await ask(bearer), null, 'no client address is not loopback');
  assert.equal(
    await ask({ ...bearer, [CLIENT_IP_HEADER]: '203.0.113.9' }),
    null,
  );

  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(
      await ask({ ...bearer, [CLIENT_IP_HEADER]: '127.0.0.1' }),
      null,
      'inert in production',
    );
  } finally {
    process.env.NODE_ENV = env;
  }

  const tail = bearerStack(
    authApiKeys({ sk_ops: systemActor('ops') }),
    devTokens.loopbackOnly(),
  );
  assert.deepEqual(
    await tail(
      new Request('http://t/', {
        headers: {
          authorization: 'Bearer dev_user_ben',
          [CLIENT_IP_HEADER]: '::1',
        },
      }),
    ),
    userActor('usr_ben'),
    'safe as a stack tail',
  );
});

// devAuthenticate is the raw table the dev posture composes: no gate, no loopback check —
// devTokens.loopbackOnly() is what wraps it for anything that binds a port.
test('devAuthenticate: an ungated table over a token list, strict bearer grammar and all', async () => {
  const auth = devAuthenticate([
    { label: 'ada', token: 'dev_user_ada', principal: userActor('usr_ada') },
  ]);
  const ask = (value: string) =>
    auth(new Request('http://t/', { headers: { authorization: value } }));
  assert.deepEqual(
    await ask('Bearer dev_user_ada'),
    userActor('usr_ada'),
    'no client address needed — the raw table is ungated',
  );
  assert.equal(await ask('dev_user_ada'), null, 'a raw token answers null');
  assert.equal(
    await ask('Bearer dev_user_ben'),
    null,
    'a token outside the list answers null',
  );
});
