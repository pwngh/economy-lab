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

// The `./ops` entry point: an in-process supervisor over the lab's meter/logger
// ports. The dependency runs one way — ops imports the core, the core never
// imports ops (eslint enforces it) — and leaving the supervisor out of the
// composition is the off switch.

export {
  hashChainedAuditSink,
  jsonlAuditSink,
  verifyAuditChain,
} from '#src/ops/audit.ts';
export type {
  AuditChainReport,
  AuditPhase,
  AuditRecord,
  AuditSink,
  SignatureName,
} from '#src/ops/audit.ts';
