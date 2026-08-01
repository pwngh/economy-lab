/**
 * @pwngh/economy-adapters
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import assert from 'node:assert/strict';

export type Send = (path: string, init?: RequestInit) => Promise<Response>;

/** A dev-token topUp, keyed per call so a replay never answers for the next one. */
export const submitInit = (): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer dev_system_payments',
  },
  body: JSON.stringify({
    kind: 'topUp',
    idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    userId: 'usr_ada',
    amount: 'CREDIT:100.00',
    source: 'card',
  }),
});

/** Health, then an authed write that has to commit — a face that only answers /healthz is a
 *  face over nothing. */
export async function faceLegs(send: Send, label: string): Promise<void> {
  assert.equal((await send('/healthz')).status, 200, `${label}: healthz`);
  const submitted = (await (await send('/submit', submitInit())).json()) as {
    status?: string;
  };
  assert.equal(submitted.status, 'committed', `${label}: authed submit`);
}
