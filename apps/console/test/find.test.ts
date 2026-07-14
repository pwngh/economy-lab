/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The ledger search: one query resolves a txn id, an account, a chain hash (full or truncated), or
 * the checkpoint's Merkle root / signature to the drill where it lives.
 */

import { expect, it } from 'vitest';

import { buildEngine } from '../app/economy';

it('resolves txn id, account, chain hash, truncated hash, and checkpoint', async () => {
  const eco = await buildEngine();

  // A real posting and one of its accounts.
  const page = await eco.ledger({ offset: 0, limit: 5 });
  const txnId = page.rows[0].id;
  const posting = await eco.posting(txnId);
  if (posting === null) {
    throw new Error('seed produced no postings');
  }
  const account = posting.legs[0].account;

  // txn id → the posting.
  expect(await eco.find(txnId)).toEqual({ kind: 'txn', txnId });

  // account → its newest posting drill.
  expect(await eco.find(account)).toMatchObject({ kind: 'account', account });

  // A chain hash from that account's lineage → the link that carries it.
  const links = await eco.lineage(account);
  const hash = links[links.length - 1].hash;
  expect(await eco.find(hash)).toMatchObject({ kind: 'link', account });

  // The truncated display form of the same hash resolves too.
  const truncated = `${hash.slice(0, 8)}…${hash.slice(-6)}`;
  expect(await eco.find(truncated)).toMatchObject({ kind: 'link', account });

  // The checkpoint's Merkle root (seed seals one).
  const cp = await eco.checkpoint();
  if (cp === null) {
    throw new Error('seed sealed no checkpoint');
  }
  expect(await eco.find(cp.root)).toMatchObject({
    kind: 'checkpoint',
    field: 'root',
  });
  expect(await eco.find(cp.signature)).toMatchObject({
    kind: 'checkpoint',
    field: 'signature',
  });

  // A junk hash and an empty query are clean misses.
  expect(await eco.find('deadbeef'.repeat(8))).toBeNull();
  expect(await eco.find('   ')).toBeNull();
});
