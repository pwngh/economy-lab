/**
 * @pwngh/economy-core
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
import { resolveEconomyModule } from '../src/module.js';
import {
  authApiKeys,
  authJwks,
  systemActor,
  userActor,
} from '@pwngh/economy-auth';
import { openTestEconomy, signEdDSAToken } from '@pwngh/economy-test';
import { credits } from '@pwngh/economy-money';

test('authApiKeys: the right bearer resolves its principal, anything else is null', async () => {
  const t = await openTestEconomy({
    authenticate: authApiKeys({ sk_test_1: systemActor('payments') }),
  });
  const submit = (key: string) =>
    t.app.handler(
      new Request('http://t/submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: '{}',
      }),
    );
  assert.equal((await submit('sk_wrong')).status, 401);
  assert.notEqual((await submit('sk_test_1')).status, 401);
  await t.close();
});

test('authJwks: WebCrypto roundtrip — valid verifies, expired and foreign-key tokens refuse', async () => {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey(
    'Ed25519',
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', publicKey)),
    kid: 'k1',
    alg: 'EdDSA',
  };
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch;

  const sign = (claims: Record<string, unknown>, key = privateKey) =>
    signEdDSAToken(claims, { privateKey: key, kid: 'k1' });
  const auth = authJwks('https://issuer.example/jwks.json', {
    fetch: fakeFetch,
    issuer: 'iss1',
  });
  const ask = async (token: string) =>
    auth(
      new Request('http://t/', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

  const good = await ask(
    await sign({ sub: 'usr_ada', iss: 'iss1', exp: Date.now() / 1000 + 60 }),
  );
  assert.deepEqual(good, userActor('usr_ada'));
  assert.equal(
    await ask(
      await sign({ sub: 'usr_ada', iss: 'iss1', exp: Date.now() / 1000 - 1 }),
    ),
    null,
  );
  assert.equal(
    await ask(
      await sign({ sub: 'usr_ada', iss: 'other', exp: Date.now() / 1000 + 60 }),
    ),
    null,
  );
  const stranger = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  assert.equal(
    await ask(
      await sign(
        { sub: 'usr_ada', iss: 'iss1', exp: Date.now() / 1000 + 60 },
        stranger.privateKey,
      ),
    ),
    null,
  );
  assert.equal(await ask('not.a.jwt'), null);
});

test('flags.supervisor composes the supervisor; it ticks; worker: false with the flag refuses', async () => {
  const t = await openTestEconomy({
    authenticate: false,
    flags: { supervisor: true },
  });
  assert.ok(t.app.supervisor, 'supervisor composed');
  assert.ok(
    Array.isArray(await t.app.supervisor.tick()),
    'a tick runs the passes',
  );
  await t.close();

  assert.throws(
    () =>
      resolveEconomyModule({
        authenticate: false,
        flags: { supervisor: true },
        worker: false,
      }),
    /SEAM_SHAPE.*flags/s,
  );
  assert.throws(
    () => resolveEconomyModule({ flags: { supervisor: 'yes' } }),
    /SEAM_SHAPE.*flags/s,
  );
  assert.throws(
    () => resolveEconomyModule({ flags: { supervisor: false } }),
    /SEAM_SHAPE.*leaving it out/s,
  );
  assert.throws(
    () => resolveEconomyModule({ ops: true }),
    /UNKNOWN_EXPORT.*flags/s,
    'the old top-level seam name points at the flags namespace',
  );
});

// The 0.7.0 spelling. Both halves of the move are named, because a host reading this refusal
// has an import path to change as well as a flag, and the reserved-name refusal it would
// otherwise hit says the opposite of what is true: that nobody has claimed `ops` yet.
test('flags.ops names its 0.8.0 replacement rather than reading as unclaimed', () => {
  assert.throws(
    () => resolveEconomyModule({ authenticate: false, flags: { ops: true } }),
    (error: Error) => {
      assert.match(error.message, /UNKNOWN_EXPORT/);
      assert.match(error.message, /flags: \{ supervisor: true \}/);
      assert.match(error.message, /@pwngh\/economy-lab\/supervisor/);
      assert.doesNotMatch(error.message, /new first use/);
      return true;
    },
  );
});

test('flags: { payouts: false } is the closed economy — rail declines, saga fails fast, hold releases', async () => {
  const mod = resolveEconomyModule({
    authenticate: false,
    flags: { payouts: false },
    policy: { velocityLimitMinor: 10_000_000n, maxPayoutAttempts: 2 },
  });
  const t = await openTestEconomy(mod);
  assert.ok(
    t.app.capabilities().worker.jobs.includes('payouts'),
    'sweep listed',
  );
  const ada = t.user('ada');
  await t.fund(ada, credits(30_000));
  await ada.submit({
    kind: 'spend',
    orderId: 'o1',
    sku: 'kit',
    price: credits(25_000),
    recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
  });
  const payout = await t
    .user('ben')
    .submit({ kind: 'requestPayout', amount: credits(20_000) });
  assert.ok(payout.saga, 'the door accepts; the rail declines');
  await t.until(async () => (await payout.saga!.state()) === 'FAILED');
  await t.close();

  assert.throws(
    () => resolveEconomyModule({ flags: { payouts: true } }),
    /SEAM_SHAPE.*flags/s,
    'a known flag takes only its non-default form',
  );
  assert.throws(
    () => resolveEconomyModule({ flags: { velocity: false } }),
    /NOT_YET.*flags/s,
  );
});

test('flags.reads unmounts the read family; the write door and health stay', async () => {
  const t = await openTestEconomy({
    authenticate: false,
    flags: { reads: false },
  });
  const probe = (path: string) => t.app.handler(new Request(`http://t${path}`));
  const paths = t.app.capabilities().routes.map((r) => r.path);
  assert.ok(
    !paths.some((p) => p.startsWith('/v1/')),
    'no /v1 read routes listed',
  );
  assert.ok(
    paths.includes('/submit') && paths.includes('/healthz'),
    'writes and health remain',
  );
  assert.equal(
    (await probe('/v1/wallet')).status,
    404,
    'a read probe answers 404',
  );
  assert.equal((await probe('/healthz')).status, 200);
  await t.close();
});

test('backup and drill: the canonical export re-derives offline; a tampered line breaks it', async () => {
  const { verifyExport } = await import('@pwngh/economy-lab');
  const { signingPublicKeyHex } = await import('@pwngh/economy-lab/adapters');
  const t = await openTestEconomy({ authenticate: false });
  const ada = t.user('ada');
  await t.fund(ada, credits(400));
  await ada.submit({
    kind: 'spend',
    orderId: 'o1',
    sku: 'x',
    price: credits(120),
    recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
  });
  const lines: string[] = [];
  for await (const line of t.economy.read.export()) lines.push(line);
  const keys = [
    await signingPublicKeyHex(
      Buffer.from('economy-test', 'utf8').toString('hex'),
    ),
  ];
  const good = await verifyExport(lines, keys);
  assert.ok(good.chainIntact && good.accounts > 0);
  const tampered = lines.map((l) =>
    l.replace('"CREDIT:120.00"', '"CREDIT:1.00"'),
  );
  const bad = await verifyExport(tampered, keys);
  assert.ok(!bad.chainIntact, 'a tampered amount breaks the chain offline');
  await t.close();
});

test('providers seam: a signed purchase webhook lands in the inbox and the sweep credits it', async () => {
  const { createHmac } = await import('node:crypto');
  const { createApp } = await import('../src/app.js');
  const { spendable } = await import('../src/ops.js');
  const SECRET = 'whsec_wire';
  const { withDev } = await import('../src/index.js');
  const app = await createApp(
    withDev({
      authenticate: false,
      providers: {
        pay: (raw) => {
          const r = raw as { id: string; user: string; credits: number };
          return {
            provider: 'pay',
            eventId: r.id,
            userId: r.user,
            amount: credits(r.credits),
            source: 'card',
          };
        },
      },
    }),
    { env: { WEBHOOK_SECRET: SECRET } },
  );

  const body = JSON.stringify({
    id: 'evt_wire_1',
    user: 'usr_ada',
    credits: 250,
  });
  const post = (payload: string, sig: string) =>
    app.handler(
      new Request('http://t/webhooks/pay', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': sig,
          'x-timestamp': String(Date.now()),
        },
        body: payload,
      }),
    );

  const bad = await post(body, 'deadbeef');
  assert.notEqual(
    bad.status,
    200,
    'a wrong signature never reaches the decoder',
  );

  const sig = createHmac('sha256', SECRET).update(body).digest('hex');
  const accepted = await post(body, sig);
  assert.equal(accepted.status, 200);
  assert.equal(
    ((await accepted.json()) as { status: string }).status,
    'accepted',
  );
  const replay = await post(body, sig);
  assert.equal(
    ((await replay.json()) as { status: string }).status,
    'duplicate',
    'redelivery dedups',
  );

  assert.ok(app.worker);
  await app.worker.sweep();
  assert.deepEqual(
    await app.economy.read.balance(spendable('usr_ada')),
    credits(250),
    'the drainInbox sweep applied the topUp',
  );
  await app.close();
});
