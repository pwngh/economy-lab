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

// A worked example of shipping the ops audit trail toward write-once (WORM) storage. The
// chained sink appends to a segment file opened O_APPEND — the OS lands every write at the
// end, even across processes — and sealing renames it *.sealed.jsonl, after which nothing
// appends again. The last line's `hash` is the segment's fingerprint: record it off-host, ship
// the sealed file to an object-lock target (S3 Object Lock, GCS retention), and
// `make audit-verify` can then hold both copies to the same chain. The shipping step itself is
// the host's job; a daemon does not belong here.
//
//   node scripts/ops-audit-worm.ts     # writes a sample segment, seals it, prints next steps

import { appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { hashChainedAuditSink } from '#src/ops/index.ts';
import { systemDigest } from '#src/runtime.ts';
import { dumpStamp } from '#scripts/support/db-tools.ts';

const DIR = 'ops-audit';
mkdirSync(DIR, { recursive: true });
// A real host names segments by day and seals at rollover; the stamp keeps the example
// re-runnable.
const segment = join(DIR, `ops-audit-${dumpStamp()}.jsonl`);

const sink = hashChainedAuditSink(
  (line) => appendFileSync(segment, `${line}\n`, { flag: 'a' }),
  systemDigest(),
);

// A sample episode, exactly what a supervisor tick would emit.
sink({
  at: Date.now(),
  signature: 'stuck-saga',
  tier: 1,
  phase: 'detected',
  subject: 'pay_example',
  detail: { state: 'RESERVED', ageMs: 120_000 },
});
sink({
  at: Date.now(),
  signature: 'stuck-saga',
  tier: 1,
  phase: 'decided',
  subject: 'pay_example',
  detail: { decision: 'act', action: 'sweep', reserve: 4_000n },
});
await sink.flush();

const sealed = segment.replace(/\.jsonl$/, '.sealed.jsonl');
renameSync(segment, sealed);

console.warn(`sealed ${sealed}`);
console.warn(`verify locally:   npm run audit:verify -- ${sealed}`);
console.warn(
  'then ship the sealed segment to an object-lock bucket and record its last-line hash off-host.',
);
