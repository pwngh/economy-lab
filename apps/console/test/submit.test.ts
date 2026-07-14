/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The mounted engine HTTP service: a wire operation posted to the submit route runs through this
 * tab's ledger and returns the outcome, and a redelivered idempotency key is a duplicate that
 * posts nothing.
 */

import { expect, it } from 'vitest';

import { getEngine } from '../app/engine';
import { clientAction } from '../app/routes/submit';

interface Wire {
  status: number;
  body: { status?: string } & Record<string, unknown>;
}

async function post(body: unknown): Promise<Wire> {
  const request = new Request('http://console.test/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await clientAction({ request, params: {} } as never)) as Wire;
}

const SPEND = {
  kind: 'spend',
  idempotencyKey: 'idem_submit_1',
  actor: { kind: 'user', userId: 'usr_alice' },
  buyerId: 'usr_alice',
  sku: 'Aurora Avatar',
  price: 'CREDIT:100.00',
  recipients: [{ sellerId: 'usr_nova', shareBps: 10000 }],
  orderId: 'ord_submit_1',
};

it('runs a wire operation through the ledger and returns the committed outcome', async () => {
  await (await getEngine()).reset();
  const res = await post(SPEND);
  expect(res.status).toBe(200);
  const body = res.body as {
    status: string;
    transaction: { legs: { account: string; amount: string }[] };
  };
  expect(body.status).toBe('committed');
  // Alice's spendable is debited the full price; the split lands on the seller and platform.
  const debit = body.transaction.legs.find(
    (l) => l.account === 'usr_alice:spendable',
  );
  expect(debit?.amount).toBe('CREDIT:100.00');
});

it('a redelivered idempotency key is a duplicate that posts nothing new', async () => {
  await (await getEngine()).reset();
  const first = await post(SPEND);
  expect(first.body.status).toBe('committed');
  const second = await post(SPEND);
  expect(second.body.status).toBe('duplicate');
});

it('a malformed operation body comes back as a problem response, not a crash', async () => {
  await (await getEngine()).reset();
  const res = await post({ kind: 'nonsense' });
  expect(res.status).toBeGreaterThanOrEqual(400);
});
