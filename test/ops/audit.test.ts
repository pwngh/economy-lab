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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GENESIS_HEX } from '#src/ledger.ts';
import { hashChainedAuditSink, verifyAuditChain } from '#src/ops/index.ts';
import { seededDigest } from '#test/support/capabilities.ts';

import type { AuditRecord } from '#src/ops/index.ts';

function episode(): AuditRecord[] {
  return [
    {
      at: 10,
      signature: 'stuck-saga',
      tier: 1,
      phase: 'detected',
      subject: 'pay_1',
      detail: { state: 'RESERVED', ageMs: 90_000 },
    },
    {
      at: 10,
      signature: 'stuck-saga',
      tier: 1,
      phase: 'decided',
      subject: 'pay_1',
      detail: { decision: 'act', action: 'runOnce', reserve: 4_000n },
    },
    {
      at: 20,
      signature: 'integrity-mismatch',
      tier: 3,
      phase: 'escalated',
      subject: null,
      detail: { proof: { conserved: false, shortfall: 12n } },
    },
  ];
}

async function chainedLines(): Promise<string[]> {
  const lines: string[] = [];
  const sink = hashChainedAuditSink(
    (line) => lines.push(line),
    seededDigest(1),
  );
  for (const record of episode()) {
    sink(record);
  }
  await sink.flush();
  return lines;
}

test('the chained sink writes an intact chain from genesis, bigints included', async () => {
  const lines = await chainedLines();

  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]) as { prev: string; hash: string };
  assert.equal(first.prev, GENESIS_HEX);
  const second = JSON.parse(lines[1]) as {
    prev: string;
    detail: Record<string, unknown>;
  };
  assert.equal(second.prev, first.hash);
  assert.deepEqual(second.detail.reserve, { $bigint: '4000' });

  const report = await verifyAuditChain(lines, seededDigest(1));
  assert.deepEqual(report, { intact: true, firstBreak: null, count: 3 });
});

test('editing a record breaks the chain at exactly that line', async () => {
  const lines = await chainedLines();
  lines[1] = lines[1].replace('"$bigint":"4000"', '"$bigint":"4001"');

  const report = await verifyAuditChain(lines, seededDigest(1));
  assert.deepEqual(report, {
    intact: false,
    firstBreak: { line: 2, reason: 'tampered-hash' },
    count: 1,
  });
});

test('rewriting a prev pointer or dropping a line reports a broken link', async () => {
  const lines = await chainedLines();

  const relinked = [...lines];
  relinked[2] = relinked[2].replace(
    /"prev":"[0-9a-f]{64}"/,
    `"prev":"${'ab'.repeat(32)}"`,
  );
  const relinkReport = await verifyAuditChain(relinked, seededDigest(1));
  assert.deepEqual(relinkReport.firstBreak, { line: 3, reason: 'broken-link' });

  const dropped = [lines[0], lines[2]];
  const dropReport = await verifyAuditChain(dropped, seededDigest(1));
  assert.deepEqual(dropReport, {
    intact: false,
    firstBreak: { line: 2, reason: 'broken-link' },
    count: 1,
  });
});

test('a non-chained or garbled line is malformed, not silently skipped', async () => {
  const lines = await chainedLines();
  lines[1] = '{"at":10,"signature":"stuck-saga"}';

  const report = await verifyAuditChain(lines, seededDigest(1));
  assert.deepEqual(report.firstBreak, { line: 2, reason: 'malformed' });
});
