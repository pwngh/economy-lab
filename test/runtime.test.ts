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

import {
  jsonlLogger,
  systemSigner,
  signingPublicKeyHex,
} from '#src/runtime.ts';
import { fromHex } from '#src/bytes.ts';

describe('jsonlLogger', () => {
  test('writes one parseable JSON line per call', () => {
    const lines: string[] = [];
    const log = jsonlLogger({
      service: 'svc',
      now: () => 1234,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    });

    log.log('info', 'worker.sweep', { ok: true });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes('\n'), false);
    assert.deepEqual(JSON.parse(lines[0]), {
      ts: 1234,
      level: 'info',
      service: 'svc',
      event: 'worker.sweep',
      ok: true,
    });
  });

  test('routes error to the err sink and others to out', () => {
    const out: string[] = [];
    const err: string[] = [];
    const log = jsonlLogger({
      now: () => 0,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });

    log.log('debug', 'a', {});
    log.log('info', 'b', {});
    log.log('warn', 'c', {});
    log.log('error', 'd', {});

    assert.equal(out.length, 3);
    assert.equal(err.length, 1);
    assert.equal(JSON.parse(err[0]).event, 'd');
  });

  test('defaults the service tag', () => {
    const lines: string[] = [];
    const log = jsonlLogger({ now: () => 0, out: (line) => lines.push(line) });

    log.log('info', 'e', {});

    assert.equal(JSON.parse(lines[0]).service, 'economy-lab');
  });
});

describe('systemSigner (Ed25519)', () => {
  test('a signature verifies with the published public key alone — no secret', async () => {
    const secret = 'a1b2c3d4'.repeat(8);
    const signer = systemSigner({ signingKey: secret });
    const root = new TextEncoder().encode('merkle-root-of-a-checkpoint');
    const sig = await signer.sign(root);

    // Ed25519 signatures are 64 bytes.
    assert.equal(sig.length, 64);

    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromHex(await signingPublicKeyHex(secret)),
      { name: 'Ed25519' },
      true,
      ['verify'],
    );
    assert.equal(
      await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, sig, root),
      true,
    );
    assert.equal(
      await crypto.subtle.verify(
        { name: 'Ed25519' },
        publicKey,
        sig,
        new TextEncoder().encode('tampered'),
      ),
      false,
    );
  });

  test('a different secret cannot forge or verify; the same secret is deterministic', async () => {
    const root = new TextEncoder().encode('x');
    const sigA = await systemSigner({ signingKey: 'aa'.repeat(16) }).sign(root);

    assert.equal(
      await systemSigner({ signingKey: 'bb'.repeat(16) }).verify(root, sigA),
      false,
    );
    assert.equal(
      await systemSigner({ signingKey: 'aa'.repeat(16) }).verify(root, sigA),
      true,
    );
  });
});
