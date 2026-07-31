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

/**
 * The export's boundary line: an archived ledger exports its signed archive boundary, and
 * offline verification anchors the chains there, authenticates the boundary, and verifies a
 * post-archive checkpoint over merged sums. Without the line, the same file must fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEconomy, memoryPorts } from '#src/index.ts';
import { createWorker } from '#src/worker/index.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  fixedClock,
  sequentialIds,
  signingPublicKeyHex,
  systemDigest,
} from '#src/runtime.ts';
import { verifyExport } from '#src/verify-export.ts';
import { topUp, spend, idempotencyKey } from '#src/operation.ts';
import { credits } from '#src/money.ts';
import { systemActor, userActor } from '#src/actor.ts';

import type { ArchivedPosting, ArchiveSink } from '#src/ports.ts';

const SECRET = 'export-boundary-test';
const hexOf = (secret: string) => Buffer.from(secret, 'utf8').toString('hex');

async function archivedEconomy() {
  const digest = systemDigest();
  const clock = fixedClock(1_000);
  const store = memoryStore({ digest, clock });
  const ports = {
    ...memoryPorts({ signingKey: SECRET }),
    store,
    digest,
    clock,
    ids: sequentialIds(),
  };
  const economy = createEconomy(ports);
  const pages: ArchivedPosting[][] = [];
  const sink: ArchiveSink = {
    put: async (page) => {
      pages.push([...page]);
    },
  };
  const worker = createWorker(ports, economy, {
    archive: { sink, checkpointOlderThanMs: 1_000 },
  });

  const actor = systemActor('test');
  for (let i = 1; i <= 4; i += 1) {
    await economy.submit(
      topUp({
        idempotencyKey: idempotencyKey('xb', String(i)),
        actor,
        userId: 'usr_a',
        amount: credits(100),
        source: 'card',
      }),
    );
  }
  await economy.submit(
    spend({
      idempotencyKey: idempotencyKey('xb', 'spend'),
      actor: userActor('usr_a'),
      orderId: 'ord_1',
      buyerId: 'usr_a',
      sku: 'x',
      price: credits(50),
      recipients: [{ sellerId: 'usr_b', shareBps: 10_000 }],
    }),
  );

  await worker.sweep(); // seals the first checkpoint
  clock.advance(10_000);
  // A full cycle reseals first, and a fresh seal postpones archival; the targeted pass
  // archives against the now-old checkpoint.
  const run = await worker.sweep({ only: ['archive'] });
  assert.ok(run.batch.archive.ok);
  assert.ok(pages.flat().length > 0, 'the sink received archived postings');

  await economy.submit(
    topUp({
      // a live tail past the boundary
      idempotencyKey: idempotencyKey('xb', 'tail'),
      actor,
      userId: 'usr_a',
      amount: credits(25),
      source: 'card',
    }),
  );
  clock.advance(1_000);
  // A checkpoint verifies against the exported tip, so export right after a seal.
  await worker.sweep({ only: ['checkpoint'] });

  const lines: string[] = [];
  for await (const line of economy.read.export()) lines.push(line);
  await economy.close();
  return lines;
}

test('an archived export carries the boundary; offline verification anchors and authenticates it', async () => {
  const lines = await archivedEconomy();
  assert.ok(
    lines.some((l) => l.includes('"type":"boundary"')),
    'boundary line present',
  );

  const keys = [await signingPublicKeyHex(hexOf(SECRET))];
  const report = await verifyExport(lines, keys);
  assert.ok(report.chainIntact, 'chains anchor at the archived heads');
  assert.equal(report.boundary.present, true);
  assert.equal(
    report.boundary.verified,
    true,
    'the boundary authenticates offline',
  );
  assert.equal(
    report.checkpoint.verified,
    true,
    'the post-archive seal verifies over merged sums',
  );

  const withoutBoundary = lines.filter((l) => !l.includes('"type":"boundary"'));
  const broken = await verifyExport(withoutBoundary, keys);
  assert.ok(
    !broken.chainIntact,
    'dropping the boundary leaves the chains starting mid-air',
  );

  const tampered = lines.map((l) =>
    l.includes('"type":"boundary"')
      ? l.replace(/"sum":"(\d+)"/, '"sum":"9$1"')
      : l,
  );
  const forged = await verifyExport(tampered, keys);
  assert.equal(
    forged.boundary.verified,
    false,
    'an edited archived sum fails authentication',
  );
  // The anchors every named account's chain starts from came out of a boundary that failed its
  // signature, so the chain verdict rests on nothing. The live prover refuses over exactly this
  // (loadArchiveBoundary faults CHAIN_BROKEN); the artifact an auditor runs must not answer
  // "intact" where the live path throws.
  assert.equal(
    forged.chainIntact,
    false,
    'a boundary that fails authentication takes the chain verdict with it',
  );

  const unchecked = await verifyExport(lines, []);
  assert.equal(unchecked.boundary.present, true);
  assert.equal(unchecked.boundary.signatureChecked, false);
  assert.equal(
    unchecked.chainIntact,
    false,
    'an archived export verified with no key anchors on boundary rows nobody checked',
  );
});
