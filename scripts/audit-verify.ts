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

// Verifies a hash-chained ops audit trail (JSONL written by `hashChainedAuditSink`): re-derives
// the chain and reports the first break. The observer must be as tamper-evident as the observed.
//
//   npm run audit:verify -- ops-audit/<segment>.jsonl
//   make audit-verify FILE=ops-audit/<segment>.jsonl

import { readFile } from 'node:fs/promises';

import { verifyAuditChain } from '#src/ops/index.ts';
import { systemDigest } from '#src/runtime.ts';

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: scripts/audit-verify.ts <audit.jsonl>');
  // eslint-disable-next-line n/no-process-exit
  process.exit(1);
}

const text = await readFile(file, 'utf8');
const lines = text.split('\n').filter((line) => line !== '');
const report = await verifyAuditChain(lines, systemDigest());

if (report.intact) {
  console.warn(
    `intact: ${report.count} record(s), the chain verifies end to end`,
  );
} else {
  console.error(
    `BROKEN at line ${report.firstBreak!.line} (${report.firstBreak!.reason}); ` +
      `${report.count} record(s) verified before the break`,
  );
  // eslint-disable-next-line n/no-process-exit
  process.exit(1);
}
