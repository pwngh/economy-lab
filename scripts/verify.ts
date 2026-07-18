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
 * Standalone verification of an exported ledger — no store, no economy boot; the file is the
 * only input. Re-proves every account's hash chain from the export's links, then checks the
 * embedded checkpoint's Merkle root and Ed25519 signature against the supplied public keys.
 *
 *   node scripts/verify.ts export.jsonl --key <hex Ed25519 public key> [--key <older key>]...
 *   make ledger-verify FILE=export.jsonl KEY=<hex public key>
 *
 * Produce the file with `economy.read.export()`; publish the key with `signingPublicKeyHex`.
 * Prints a JSON report; exits 0 when everything asked of it verified, 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { verifyExport } from '#scripts/support/verify-lib.ts';

function usage(): void {
  console.error(
    'Usage: node scripts/verify.ts <export.jsonl> [--key <hex Ed25519 public key>]...',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const keys: string[] = [];
  let file: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--key') {
      i += 1;
      const key = args[i];
      if (key === undefined || key === '') {
        usage();
        process.exitCode = 2;
        return;
      }
      keys.push(key);
    } else {
      file = args[i];
    }
  }
  if (file === undefined) {
    usage();
    process.exitCode = 2;
    return;
  }

  const report = await verifyExport(
    readFileSync(file, 'utf8').split('\n'),
    keys,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const checkpointOk =
    !report.checkpoint.signatureChecked || report.checkpoint.verified === true;
  process.exitCode = report.chainIntact && checkpointOk ? 0 : 1;
}

await main();
