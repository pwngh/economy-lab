/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The ledger explorer drill over the engine read surface (read.posting / statement / lineage /
 * checkpoint), through the facade and the route loader.
 */

import { expect, it } from 'vitest';

import { getEngine } from '../app/engine';
import { callRoute } from './support';

it('drills a posting into its account statement and hash chain', async () => {
  const eco = await getEngine();
  await eco.reset();

  const feed = await eco.ledger({ offset: 0, limit: 5 });
  const txnId = feed.rows[0].id;

  const posting = await eco.posting(txnId);
  if (posting === null) {
    throw new Error('seed produced no postings');
  }
  expect(posting.id).toBe(txnId);
  expect(await eco.posting('txn_does_not_exist')).toBeNull();

  const account = posting.legs[0].account;
  const statement = await eco.statement(account);
  expect(statement.account).toBe(account);
  expect(statement.entries.length).toBeGreaterThan(0);

  const lineage = await eco.lineage(account);
  expect(lineage.length).toBeGreaterThan(0);
  expect(lineage[0].prevHash).toBe('0'.repeat(64));
  if (lineage.length > 1) {
    expect(lineage[1].prevHash).toBe(lineage[0].hash);
  }

  const checkpoint = await eco.checkpoint();
  expect(checkpoint === null || typeof checkpoint.root === 'string').toBe(true);
});

it('the txn detail loader resolves a posting and its account drill', async () => {
  const eco = await getEngine();
  await eco.reset();

  const feed = await eco.ledger({ offset: 0, limit: 5 });
  const txnId = feed.rows[0].id;
  const posting = await eco.posting(txnId);
  if (posting === null) {
    throw new Error('seed produced no postings');
  }
  const account = posting.legs[0].account;

  const { clientLoader } = await import('../app/routes/ledger.txn.$id');
  const data = await callRoute(
    clientLoader,
    new Request(
      `http://console.test/ledger/txn/${txnId}?account=${encodeURIComponent(account)}`,
    ),
    { id: txnId },
  );

  expect(data.posting?.id).toBe(txnId);
  expect(data.statement?.account).toBe(account);
  expect((data.lineage ?? []).length).toBeGreaterThan(0);
});
