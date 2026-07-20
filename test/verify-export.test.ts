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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { recordCheckpoint } from '#src/chain.ts';
import { EXPORT_FORMAT } from '#src/economy.ts';
import { signingPublicKeyHex, systemSigner } from '#src/runtime.ts';
import { encodeAmount } from '#src/money.ts';
import { parseExport, verifyExport } from '#src/verify-export.ts';
import { economyWithStore } from '#test/support/economy.ts';
import { credit } from '#test/support/builders.ts';
import {
  fixedClock,
  seededDigest,
  sequentialIds,
} from '#test/support/capabilities.ts';

import type { Economy, Operation } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

const SIGNING_KEY = 'ee'.repeat(32);

function topUp(userId: string, dollars: string): Operation {
  return {
    kind: 'topUp',
    idempotencyKey: `idem_${userId}`,
    actor: { kind: 'system', service: 'test' },
    userId,
    source: 'card',
    amount: credit(dollars),
  } as Operation;
}

// Two funded users, then a checkpoint sealed by the real Ed25519 signer over the same store.
async function exportedLedger(): Promise<{
  economy: Economy;
  store: Store;
  lines: string[];
}> {
  const { economy, store } = economyWithStore(1);
  await economy.submit(topUp('usr_a', '10.00'));
  await economy.submit(topUp('usr_b', '4.00'));
  await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: store.checkpoints,
    digest: seededDigest(1),
    signer: systemSigner({ signingKey: SIGNING_KEY }),
    clock: fixedClock(0),
    ids: sequentialIds(),
  });
  const lines: string[] = [];
  for await (const line of economy.read.export()) {
    lines.push(line);
  }
  return { economy, store, lines };
}

describe('read.export', () => {
  test('emits a header, one line per chain link, then the checkpoint', async () => {
    const { lines } = await exportedLedger();

    assert.deepEqual(JSON.parse(lines[0]!), { format: EXPORT_FORMAT, v: 1 });
    const kinds = lines.slice(1).map((line) => JSON.parse(line).type as string);
    assert.equal(
      kinds.slice(0, -1).every((kind) => kind === 'link'),
      true,
    );
    assert.equal(kinds.at(-1), 'checkpoint');
    // Two topUps touching a user account and platform accounts each: several links exist.
    assert.equal(kinds.filter((kind) => kind === 'link').length >= 4, true);
  });

  test('amounts ride as decimal strings, never JSON numbers', async () => {
    const { lines } = await exportedLedger();

    const link = JSON.parse(lines[1]!) as {
      link: { legs: Array<{ amount: unknown }> };
    };
    assert.equal(typeof link.link.legs[0]!.amount, 'string');
    assert.equal(
      lines.some((line) => line.includes(encodeAmount(credit('10.00')))),
      true,
    );
  });
});

describe('verifyExport', () => {
  test('proves the chain and verifies the checkpoint from the file alone', async () => {
    const { lines } = await exportedLedger();

    const report = await verifyExport(
      lines,
      [await signingPublicKeyHex(SIGNING_KEY)],
      seededDigest(1),
    );

    assert.equal(report.chainIntact, true);
    assert.equal(report.firstBreak, null);
    assert.equal(report.accounts >= 3, true);
    assert.equal(report.checkpoint.present, true);
    assert.equal(report.checkpoint.signatureChecked, true);
    assert.equal(report.checkpoint.verified, true);
    assert.equal(typeof report.checkpoint.kid, 'string');
  });

  test('a tampered amount in one link breaks the chain proof', async () => {
    const { lines } = await exportedLedger();
    const target = lines.findIndex((line) =>
      line.includes(encodeAmount(credit('10.00'))),
    );
    lines[target] = lines[target]!.replaceAll('10.00', '99.00');

    const report = await verifyExport(lines, [], seededDigest(1));

    assert.equal(report.chainIntact, false);
    assert.notEqual(report.firstBreak, null);
  });

  test('a wrong public key leaves the checkpoint unverified', async () => {
    const { lines } = await exportedLedger();

    const report = await verifyExport(
      lines,
      [await signingPublicKeyHex('ab'.repeat(32))],
      seededDigest(1),
    );

    assert.equal(report.chainIntact, true);
    assert.equal(report.checkpoint.verified, false);
  });

  test('no key means the signature is reported unchecked, not passed', async () => {
    const { lines } = await exportedLedger();

    const report = await verifyExport(lines, [], seededDigest(1));

    assert.equal(report.checkpoint.present, true);
    assert.equal(report.checkpoint.signatureChecked, false);
    assert.equal('verified' in report.checkpoint, false);
  });

  test('refuses a file without the export header', async () => {
    assert.throws(
      () => parseExport(['{"hello":"world"}']),
      /Not a ledger export/,
    );
  });
});
