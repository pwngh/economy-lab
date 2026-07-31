/**
 * @pwngh/economy-test
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
import { devAuthenticate, userActor } from '@pwngh/economy-auth';
// The grammar is internal: reached by file, never by the package root, like testApp.
import { bearerOf, devGrammar } from '../src/lib/dev-grammar.js';

const asRequest = (header?: string): Request =>
  new Request(
    'http://t/v1/wallet',
    header === undefined ? {} : { headers: { authorization: header } },
  );

// Each row is a header and the credential the strict grammar must read out of it. The pairs
// that answer null are the whole point: a raw credential is not a bearer token.
const CASES: ReadonlyArray<
  readonly [string, string | undefined, string | null]
> = [
  ['no header at all', undefined, null],
  ['canonical', 'Bearer dev_user_ada', 'dev_user_ada'],
  ['lower scheme', 'bearer dev_user_ada', 'dev_user_ada'],
  ['upper scheme', 'BEARER dev_user_ada', 'dev_user_ada'],
  ['mixed scheme', 'bEaReR dev_user_ada', 'dev_user_ada'],
  ['two spaces', 'Bearer  dev_user_ada', 'dev_user_ada'],
  ['tab separator', 'Bearer\tdev_user_ada', 'dev_user_ada'],
  ['form feed separator', 'Bearer\fdev_user_ada', 'dev_user_ada'],
  // A Headers value is trimmed of surrounding whitespace before either grammar sees it.
  ['leading space', ' Bearer dev_user_ada', 'dev_user_ada'],
  ['trailing space', 'Bearer dev_user_ada ', 'dev_user_ada'],
  ['raw credential', 'dev_user_ada', null],
  ['no separator', 'Bearerdev_user_ada', null],
  ['empty credential', 'Bearer ', null],
  ['scheme only', 'Bearer', null],
  ['wrong scheme', 'Basic dev_user_ada', null],
  ['trailing junk', 'Bearer dev_user_ada extra', 'dev_user_ada extra'],
  ['doubled scheme', 'Bearer Bearer dev_user_ada', 'Bearer dev_user_ada'],
];

// packages/auth keeps its `bearerOf` package-internal, so read its answer through the one
// public door that runs it: a table holding every credential the rows above can yield.
const CREDENTIALS = [
  ...new Set(CASES.map(([, , want]) => want).filter((w) => w !== null)),
];
const shipped = devAuthenticate(
  CREDENTIALS.map((token, i) => ({
    label: `probe${i}`,
    token,
    principal: userActor(`usr_probe${i}`),
  })),
);
// A hit names which credential the shipped grammar extracted; a miss means it extracted none,
// because every credential these rows can produce is in the table.
const shippedRead = async (header?: string): Promise<string | null> => {
  const principal = await shipped(asRequest(header));
  if (principal === null || principal.kind !== 'user') return null;
  return CREDENTIALS[Number(principal.userId.replace('usr_probe', ''))] ?? null;
};

// `packages/test/src/lib/dev-grammar.ts` mirrors `packages/auth/src/lib/bearer.ts` because the
// auth package will not export it. This is the pin that makes the copy drift loudly.
test('the harness bearer grammar answers exactly what the shipped resolver answers', async () => {
  for (const [name, header, want] of CASES) {
    assert.equal(
      await shippedRead(header),
      want,
      `${name}: the shipped resolver`,
    );
    assert.equal(
      bearerOf(asRequest(header)),
      want,
      `${name}: the harness mirror`,
    );
  }
});

// The grammar decides who calls, so the dev reading on top of it is pinned to the same rows.
test('only a bearer-framed dev token resolves to a principal', async () => {
  assert.equal(
    (await devGrammar(asRequest('Bearer dev_user_ada')))?.kind,
    'user',
  );
  assert.equal(
    (await devGrammar(asRequest('Bearer dev_system_payments')))?.kind,
    'system',
  );
  assert.equal(
    (await devGrammar(asRequest('Bearer dev_operator_root')))?.kind,
    'operator',
  );
  assert.equal(
    await devGrammar(asRequest('dev_user_ada')),
    null,
    'a raw token is not a bearer',
  );
  assert.equal(
    await devGrammar(asRequest('Bearer usr_ada')),
    null,
    'a user id is not a token',
  );
  assert.equal(
    await devGrammar(asRequest()),
    null,
    'no header is no principal',
  );
});
