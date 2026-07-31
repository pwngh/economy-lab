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
  authApiKeys,
  authJwks,
  devTokens,
  systemActor,
  userActor,
} from '../src/index.js';
import { CLIENT_IP_HEADER } from '@pwngh/economy-lab/server';
import { signEdDSAToken } from '@pwngh/economy-test';

// One signing identity per suite run; each test builds its own JWKS answer around it.
const { publicKey, privateKey } = (await crypto.subtle.generateKey(
  'Ed25519',
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const JWK = {
  ...(await crypto.subtle.exportKey('jwk', publicKey)),
  alg: 'EdDSA',
};

const sign = (claims: Record<string, unknown>, kid = 'k1') =>
  signEdDSAToken(claims, { privateKey, kid });

// A token carrying no `kid` at all, so key choice falls to the algorithm filter alone.
const signWithoutKid = (claims: Record<string, unknown>) =>
  signEdDSAToken(claims, { privateKey });

// A JWKS endpoint stub that counts its fetches and serves whatever body it is told to.
const jwksServer = (body: () => unknown) => {
  const state = { fetches: 0 };
  const doFetch = (async () => {
    state.fetches += 1;
    const b = body();
    return new Response(typeof b === 'string' ? b : JSON.stringify(b));
  }) as typeof fetch;
  return { state, fetch: doFetch };
};

const withHeader = (value: string) =>
  new Request('http://t/', { headers: { authorization: value } });

test('strict bearer: authApiKeys requires the Bearer prefix; the scheme is case-insensitive', async () => {
  const auth = authApiKeys({ sk_test_1: systemActor('payments') });
  assert.deepEqual(
    await auth(withHeader('Bearer sk_test_1')),
    systemActor('payments'),
  );
  assert.deepEqual(
    await auth(withHeader('bearer sk_test_1')),
    systemActor('payments'),
  );
  assert.deepEqual(
    await auth(withHeader('BEARER sk_test_1')),
    systemActor('payments'),
  );
  assert.deepEqual(
    await auth(withHeader('Bearer  sk_test_1')),
    systemActor('payments'),
    'separator width is lenient; the prefix never is',
  );
  assert.equal(
    await auth(withHeader('sk_test_1')),
    null,
    'a raw credential answers null',
  );
  assert.equal(
    await auth(withHeader('Bearersk_test_1')),
    null,
    'the scheme needs its space',
  );
  assert.equal(await auth(withHeader('Basic sk_test_1')), null);
  assert.equal(await auth(withHeader('Bearer')), null);
  assert.equal(
    await auth(withHeader('Bearer ')),
    null,
    'an empty credential answers null',
  );
});

test('strict bearer: authJwks refuses a raw JWT sent without the prefix', async () => {
  const { fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid: 'k1' }],
  }));
  const auth = authJwks('https://idp.example/jwks.json', { fetch: doFetch });
  const token = await sign({ sub: 'usr_ada', exp: Date.now() / 1000 + 60 });
  assert.deepEqual(
    await auth(withHeader(`Bearer ${token}`)),
    userActor('usr_ada'),
  );
  assert.equal(await auth(withHeader(token)), null, 'a raw JWT answers null');
});

test('strict bearer: the dev-token table requires the prefix too', async () => {
  const auth = devTokens.loopbackOnly();
  const ask = (value: string) =>
    auth(
      new Request('http://t/', {
        headers: { authorization: value, [CLIENT_IP_HEADER]: '127.0.0.1' },
      }),
    );
  assert.deepEqual(await ask('Bearer dev_user_ada'), userActor('usr_ada'));
  assert.equal(await ask('dev_user_ada'), null, 'a raw dev token answers null');
});

test('clock skew: exp/nbf are exact by default; clockToleranceMs widens both edges', async () => {
  const { fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid: 'k1' }],
  }));
  const now = Date.now() / 1000;
  const ask = async (
    toleranceMs: number | undefined,
    claims: Record<string, unknown>,
  ) => {
    const auth = authJwks('https://idp.example/jwks.json', {
      fetch: doFetch,
      ...(toleranceMs === undefined ? {} : { clockToleranceMs: toleranceMs }),
    });
    return auth(
      withHeader(`Bearer ${await sign({ sub: 'usr_ada', ...claims })}`),
    );
  };
  assert.equal(
    await ask(undefined, { exp: now - 10 }),
    null,
    'default is exact',
  );
  assert.equal(await ask(undefined, { exp: now + 60, nbf: now + 10 }), null);
  assert.deepEqual(await ask(30_000, { exp: now - 10 }), userActor('usr_ada'));
  assert.deepEqual(
    await ask(30_000, { exp: now + 60, nbf: now + 10 }),
    userActor('usr_ada'),
  );
  assert.equal(
    await ask(30_000, { exp: now - 60 }),
    null,
    'beyond the tolerance still refuses',
  );
});

test('cold start: concurrent verifications share one JWKS fetch and both verify', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const state = { fetches: 0 };
  const doFetch = (async () => {
    state.fetches += 1;
    await gate;
    return new Response(JSON.stringify({ keys: [{ ...JWK, kid: 'k1' }] }));
  }) as typeof fetch;
  const auth = authJwks('https://idp.example/jwks.json', { fetch: doFetch });
  const token = await sign({ sub: 'usr_ada', exp: Date.now() / 1000 + 60 });
  const asks = [
    auth(withHeader(`Bearer ${token}`)),
    auth(withHeader(`Bearer ${token}`)),
  ];
  release();
  assert.deepEqual(await Promise.all(asks), [
    userActor('usr_ada'),
    userActor('usr_ada'),
  ]);
  assert.equal(state.fetches, 1, 'the in-flight fetch is shared, never herded');
});

test('cacheMs: 0 means no cache — every verification refetches, same-millisecond included', async () => {
  const { state, fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid: 'k1' }],
  }));
  const auth = authJwks('https://idp.example/jwks.json', {
    fetch: doFetch,
    cacheMs: 0,
  });
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000; // frozen: the two calls land in one millisecond
  try {
    const token = await sign({
      sub: 'usr_ada',
      exp: 1_700_000_000_000 / 1000 + 60,
    });
    assert.deepEqual(
      await auth(withHeader(`Bearer ${token}`)),
      userActor('usr_ada'),
    );
    assert.deepEqual(
      await auth(withHeader(`Bearer ${token}`)),
      userActor('usr_ada'),
    );
    assert.equal(state.fetches, 2);
  } finally {
    Date.now = realNow;
  }
});

test('a JWKS answer that is not JSON keeps the cached key set serving', async () => {
  let broken = false;
  const { fetch: doFetch } = jwksServer(() =>
    broken ? '<html>502</html>' : { keys: [{ ...JWK, kid: 'k1' }] },
  );
  const auth = authJwks('https://idp.example/jwks.json', {
    fetch: doFetch,
    cacheMs: 0,
  });
  const token = await sign({ sub: 'usr_ada', exp: Date.now() / 1000 + 60 });
  assert.deepEqual(
    await auth(withHeader(`Bearer ${token}`)),
    userActor('usr_ada'),
  );
  broken = true;
  assert.deepEqual(
    await auth(withHeader(`Bearer ${token}`)),
    userActor('usr_ada'),
    'the IdP answering garbage never takes cached verification down',
  );
});

test('a JWKS answer that is JSON but not a key set keeps the cached keys serving', async () => {
  const bodies: unknown[] = [
    null,
    [],
    '"keys"',
    { keys: {} },
    { keys: 'nope' },
    7,
  ];
  const { fetch: doFetch } = jwksServer(() =>
    bodies.length ? bodies.shift()! : { keys: [] },
  );
  const good = jwksServer(() => ({ keys: [{ ...JWK, kid: 'k1' }] }));
  const auth = authJwks('https://idp.example/jwks.json', {
    // First answer is the good set; every later answer is one of the malformed bodies.
    fetch: (async (url: string) =>
      bodies.length === 6 ? good.fetch(url) : doFetch(url)) as typeof fetch,
    cacheMs: 0,
  });
  const token = await sign({ sub: 'usr_ada', exp: Date.now() / 1000 + 60 });
  assert.deepEqual(
    await auth(withHeader(`Bearer ${token}`)),
    userActor('usr_ada'),
  );
  for (let i = 0; i < 6; i += 1) {
    assert.deepEqual(
      await auth(withHeader(`Bearer ${token}`)),
      userActor('usr_ada'),
      'a shape that is not { keys: [...] } never replaces the cached set',
    );
  }
});

test('an HTTP-error JWKS answer keeps the cached key set serving', async () => {
  let status = 200;
  const state = { fetches: 0 };
  const doFetch = (async () => {
    state.fetches += 1;
    return new Response(JSON.stringify({ keys: [{ ...JWK, kid: 'k1' }] }), {
      status,
    });
  }) as typeof fetch;
  const auth = authJwks('https://idp.example/jwks.json', {
    fetch: doFetch,
    cacheMs: 0,
  });
  const token = await sign({ sub: 'usr_ada', exp: Date.now() / 1000 + 60 });
  assert.deepEqual(
    await auth(withHeader(`Bearer ${token}`)),
    userActor('usr_ada'),
  );
  status = 503;
  assert.deepEqual(
    await auth(withHeader(`Bearer ${token}`)),
    userActor('usr_ada'),
    'a 5xx keeps the cached keys; only a well-formed 200 replaces them',
  );
  assert.equal(state.fetches, 2);
});

test('key-set bound: a JWKS answer larger than 100 keys is refused as malformed', async () => {
  const pad = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...JWK, kid: `pad${i}` }));
  const token = await sign({ sub: 'usr_ada', exp: Date.now() / 1000 + 60 });

  const okSet = jwksServer(() => ({
    keys: [...pad(99), { ...JWK, kid: 'k1' }],
  }));
  const ok = authJwks('https://idp.example/jwks.json', { fetch: okSet.fetch });
  assert.deepEqual(
    await ok(withHeader(`Bearer ${token}`)),
    userActor('usr_ada'),
  );

  const bigSet = jwksServer(() => ({
    keys: [...pad(100), { ...JWK, kid: 'k1' }],
  }));
  const big = authJwks('https://idp.example/jwks.json', {
    fetch: bigSet.fetch,
  });
  assert.equal(await big(withHeader(`Bearer ${token}`)), null);
});

// The two knobs never contradict: cacheMs 0 already fetched at the top of the call, so the
// kid-retry floor (measured from that fetch) suppresses a second fetch in the same call.
test('cacheMs 0 with an unknown kid is one fetch per verification, never two', async () => {
  const { state, fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid: 'other' }],
  }));
  const auth = authJwks('https://idp.example/jwks.json', {
    fetch: doFetch,
    cacheMs: 0,
  });
  const token = await sign(
    { sub: 'usr_ada', exp: Date.now() / 1000 + 60 },
    'k1',
  );
  assert.equal(await auth(withHeader(`Bearer ${token}`)), null);
  assert.equal(
    state.fetches,
    1,
    'the kid miss never doubles the per-call fetch',
  );
  assert.equal(await auth(withHeader(`Bearer ${token}`)), null);
  assert.equal(
    state.fetches,
    2,
    'the next verification refetches as cacheMs 0 promises',
  );
});

// A window field that is not a finite number silently widens the window to everything:
// `now - NaN` is NaN, and every comparison against NaN is false, so exp and nbf stop
// rejecting. The construction refuses it instead, where the misconfiguration is written.
test('option guard: a non-finite clockToleranceMs is refused, never read as no limit', async () => {
  const { fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid: 'k1' }],
  }));
  const url = 'https://idp.example/jwks.json';
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => authJwks(url, { fetch: doFetch, clockToleranceMs: bad }),
      /clockToleranceMs/,
      `clockToleranceMs ${bad} must refuse at construction`,
    );
  }
  assert.throws(
    () => authJwks(url, { fetch: doFetch, clockToleranceMs: -1 }),
    /clockToleranceMs/,
    'a negative tolerance narrows the window instead of widening it — refused outright',
  );
  const ok = authJwks(url, { fetch: doFetch, clockToleranceMs: 30_000 });
  assert.equal(
    await ok(
      withHeader(
        `Bearer ${await sign({ sub: 'usr_ada', exp: Date.now() / 1000 - 86_400 })}`,
      ),
    ),
    null,
    'a token a day past exp is still refused under a valid tolerance',
  );
});

// `0` is a real cache setting; NaN is not. Left unchecked it never satisfies the refresh
// comparison, so a kid-less token never triggers a fetch at all and can never verify.
test('option guard: a non-finite or negative cacheMs is refused', async () => {
  const { fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid: 'k1' }],
  }));
  const url = 'https://idp.example/jwks.json';
  for (const bad of [NaN, Infinity, -1]) {
    assert.throws(
      () => authJwks(url, { fetch: doFetch, cacheMs: bad }),
      /cacheMs/,
      `cacheMs ${bad} must refuse at construction`,
    );
  }
  assert.ok(
    authJwks(url, { fetch: doFetch, cacheMs: 0 }),
    '0 stays a legal setting',
  );
});

// `undefined` is how a caller says "do not check this claim". A blank string is a missing
// value — an unset environment variable — and reading it as "check nothing" accepts every
// issuer and every audience in the world.
test('option guard: a blank issuer or audience is a missing value, not a disabled check', async () => {
  const { fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid: 'k1' }],
  }));
  const url = 'https://idp.example/jwks.json';
  assert.throws(() => authJwks(url, { fetch: doFetch, issuer: '' }), /issuer/);
  assert.throws(
    () => authJwks(url, { fetch: doFetch, audience: '' }),
    /audience/,
  );
  const foreign = {
    sub: 'usr_ada',
    exp: Date.now() / 1000 + 60,
    iss: 'https://evil.example',
    aud: 'not-us',
  };
  const checked = authJwks(url, {
    fetch: doFetch,
    issuer: 'https://idp.example/',
  });
  assert.equal(
    await checked(withHeader(`Bearer ${await sign(foreign)}`)),
    null,
  );
});

// A JWS is exactly three segments. Taking the first three of any longer string accepts an
// unbounded family of spellings of one credential, each of which verifies.
test('a token is exactly three segments — a trailing fourth is not a JWS', async () => {
  const { fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid: 'k1' }],
  }));
  const auth = authJwks('https://idp.example/jwks.json', { fetch: doFetch });
  const token = await sign({ sub: 'usr_ada', exp: Date.now() / 1000 + 60 });
  assert.deepEqual(
    await auth(withHeader(`Bearer ${token}`)),
    userActor('usr_ada'),
  );
  assert.equal(
    await auth(withHeader(`Bearer ${token}.junk`)),
    null,
    'a fourth segment is refused',
  );
  assert.equal(
    await auth(withHeader(`Bearer ${token}.a.b`)),
    null,
    'so is a fifth',
  );
  assert.equal(
    await auth(withHeader(`Bearer ${token}.`)),
    null,
    'so is a trailing separator',
  );
});

// Every segment is canonical base64url. `atob` is lenient — it takes the standard alphabet,
// padding, embedded whitespace, and unused trailing bits — so one signature has many
// spellings that all verify unless the decode insists on the canonical one.
test('every segment is canonical base64url — one credential has exactly one spelling', async () => {
  const { fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid: 'k1' }],
  }));
  const auth = authJwks('https://idp.example/jwks.json', { fetch: doFetch });
  const claims = { sub: 'usr_ada', exp: Date.now() / 1000 + 60 };
  // Ed25519 signs deterministically, so a nonce walks until the signature exercises both
  // base64url-only characters and the standard-alphabet respelling is a real difference.
  let nonce = 0;
  let token = await sign({ ...claims, nonce });
  while (!/[-]/.test(token.split('.')[2]!) || !/_/.test(token.split('.')[2]!)) {
    nonce += 1;
    token = await sign({ ...claims, nonce });
  }
  const [h, p, s] = token.split('.') as [string, string, string];
  assert.deepEqual(
    await auth(withHeader(`Bearer ${token}`)),
    userActor('usr_ada'),
    'the canonical spelling verifies',
  );

  const standard = s.replace(/-/g, '+').replace(/_/g, '/');
  assert.notEqual(standard, s);
  assert.equal(
    await auth(withHeader(`Bearer ${h}.${p}.${standard}`)),
    null,
    'the standard alphabet is not base64url',
  );
  assert.equal(
    await auth(withHeader(`Bearer ${h}.${p}.${s}==`)),
    null,
    'padding is not canonical',
  );
  assert.equal(
    await auth(withHeader(`Bearer ${h}.${p}.${s.slice(0, 4)} ${s.slice(4)}`)),
    null,
    'embedded whitespace is not canonical',
  );

  // The last character of a 64-byte signature carries four bits the signature does not use.
  // Every one of the fifteen other spellings decodes to the same bytes.
  const ALPHA =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const idx = ALPHA.indexOf(s.slice(-1)!);
  let variants = 0;
  for (let bits = 1; bits < 16; bits += 1) {
    const alt = ALPHA[(idx & ~0b1111) | ((idx & 0b1111) ^ bits)]!;
    if (alt === s.slice(-1)) continue;
    variants += 1;
    assert.equal(
      await auth(withHeader(`Bearer ${h}.${p}.${s.slice(0, -1)}${alt}`)),
      null,
      'a spare-bit respelling of the signature is refused',
    );
  }
  assert.equal(
    variants,
    15,
    'all fifteen spare-bit respellings were exercised',
  );
});

// exp must be a number to be checked at all; nbf was trusted to be one. A string or a
// boolean skipped the comparison entirely and the not-before window went unenforced.
test('nbf must be a number when it is present', async () => {
  const { fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid: 'k1' }],
  }));
  const auth = authJwks('https://idp.example/jwks.json', { fetch: doFetch });
  const exp = Date.now() / 1000 + 60;
  for (const nbf of ['9999999999', true, null, {}]) {
    assert.equal(
      await auth(
        withHeader(`Bearer ${await sign({ sub: 'usr_ada', exp, nbf })}`),
      ),
      null,
      `nbf ${JSON.stringify(nbf)} is malformed, not absent`,
    );
  }
  assert.deepEqual(
    await auth(withHeader(`Bearer ${await sign({ sub: 'usr_ada', exp })}`)),
    userActor('usr_ada'),
    'an absent nbf is still fine',
  );
  assert.deepEqual(
    await auth(
      withHeader(
        `Bearer ${await sign({ sub: 'usr_ada', exp, nbf: exp - 120 })}`,
      ),
    ),
    userActor('usr_ada'),
    'a past nbf is still fine',
  );
});

// The README's law is that nothing here throws at request time. A runtime with no `process`
// cannot state its environment, so the gate stays shut rather than guessing or exploding.
test('the dev table is inert, never throwing, on a runtime with no process', async () => {
  const auth = devTokens.loopbackOnly();
  const request = new Request('http://t/', {
    headers: {
      authorization: 'Bearer dev_user_ada',
      [CLIENT_IP_HEADER]: '127.0.0.1',
    },
  });
  const held = globalThis.process;
  let answer: unknown;
  try {
    Reflect.deleteProperty(globalThis, 'process');
    answer = await auth(request);
  } finally {
    globalThis.process = held;
  }
  assert.equal(
    answer,
    null,
    'no process means no stated environment, so the table stays shut',
  );
  assert.deepEqual(
    await auth(request),
    userActor('usr_ada'),
    'and it answers again once process is back',
  );
});

// `authApiKeys({ [process.env.PAYMENTS_KEY!]: actor })` with the variable unset does not
// fail — it mints a live credential spelled `undefined`. These four strings are what a
// missing or non-string value stringifies to, and none of them is a secret.
test('authApiKeys refuses a missing secret as a key', () => {
  for (const missing of ['', 'undefined', 'null', '[object Object]']) {
    assert.throws(
      () => authApiKeys({ [missing]: systemActor('payments') }),
      /authApiKeys/,
      `${JSON.stringify(missing)} is a missing secret, not a key`,
    );
  }
  assert.ok(
    authApiKeys({}),
    'an empty table is a real posture — it simply never answers',
  );
  assert.ok(authApiKeys({ sk_live_1: systemActor('payments') }));
});

// The chosen key must agree with the token: no verifying a signature with an encryption
// key, no algorithm swap. Documented since the first release and untested until now.
//
// The refusals below hold twice over — WebCrypto rejects a JWK whose `alg` or `use` fights
// the import on its own — so the last case is the one that pins this package's own filter:
// among several published keys it must skip past the ones that cannot verify this token.
test('the chosen key must agree with the token algorithm', async () => {
  const url = 'https://idp.example/jwks.json';
  const token = await sign({ sub: 'usr_ada', exp: Date.now() / 1000 + 60 });
  const withKeys = (...ks: Record<string, unknown>[]) =>
    authJwks(url, { fetch: jwksServer(() => ({ keys: ks })).fetch });

  assert.deepEqual(
    await withKeys({ ...JWK, kid: 'k1' })(withHeader(`Bearer ${token}`)),
    userActor('usr_ada'),
    'the matching key verifies',
  );
  assert.equal(
    await withKeys({ ...JWK, kid: 'k1', alg: 'RS256' })(
      withHeader(`Bearer ${token}`),
    ),
    null,
    'a key that names a different algorithm is not a candidate',
  );
  assert.equal(
    await withKeys({ ...JWK, kid: 'k1', use: 'enc' })(
      withHeader(`Bearer ${token}`),
    ),
    null,
    'an encryption key never verifies a signature',
  );
  assert.deepEqual(
    await withKeys({ ...JWK, kid: 'k1', use: 'sig' })(
      withHeader(`Bearer ${token}`),
    ),
    userActor('usr_ada'),
    'an explicit signing use is fine',
  );

  // A kid-less token against a real-world key set: the encryption key and the RS256 key
  // come first, and the filter is the only reason the EdDSA key is the one imported.
  const anon = await signWithoutKid({
    sub: 'usr_ada',
    exp: Date.now() / 1000 + 60,
  });
  assert.deepEqual(
    await withKeys(
      { ...JWK, kid: 'enc-1', use: 'enc' },
      { ...JWK, kid: 'rsa-1', alg: 'RS256' },
      { ...JWK, kid: 'ed-1' },
    )(withHeader(`Bearer ${anon}`)),
    userActor('usr_ada'),
    'the first key that can actually verify this token is the one chosen',
  );
});

test('rotation: an unknown kid retries once, floored at thirty seconds between retries', async () => {
  let kid = 'k1';
  const { state, fetch: doFetch } = jwksServer(() => ({
    keys: [{ ...JWK, kid }],
  }));
  const auth = authJwks('https://idp.example/jwks.json', { fetch: doFetch });
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const exp = realNow() / 1000 + 300;
    assert.deepEqual(
      await auth(withHeader(`Bearer ${await sign({ sub: 'usr_ada', exp })}`)),
      userActor('usr_ada'),
    );
    assert.equal(state.fetches, 1);

    kid = 'k2'; // the IdP rotates; tokens now carry the new kid
    const rotated = await sign({ sub: 'usr_ada', exp }, 'k2');
    assert.equal(
      await auth(withHeader(`Bearer ${rotated}`)),
      null,
      'inside the floor the unknown kid refuses without a refetch',
    );
    assert.equal(state.fetches, 1, 'the floor holds — no request herd');

    offset = 31_000;
    assert.deepEqual(
      await auth(withHeader(`Bearer ${rotated}`)),
      userActor('usr_ada'),
      'past the floor the unknown kid triggers one immediate refresh',
    );
    assert.equal(state.fetches, 2);
  } finally {
    Date.now = realNow;
  }
});
