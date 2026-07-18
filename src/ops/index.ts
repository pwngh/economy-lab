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

export { opsRuntime } from '#src/ops/runtime.ts';
export type { OpsRuntime, Signal, SignalFeed } from '#src/ops/runtime.ts';

export {
  detectDeadlockStorm,
  detectEngineStall,
  detectInboxDeadLetters,
  detectIntegrityMismatches,
  detectOutboxBacklog,
  detectRetryExhaustion,
  detectSilences,
  detectSlowSeal,
  detectStuckSagas,
  detectTreasuryBreaches,
  detectVelocityAnomaly,
  detectWebhookReplayStorm,
} from '#src/ops/detect.ts';
export type {
  DeadlockStormFinding,
  EngineStallFinding,
  Finding,
  InboxDeadLetterFinding,
  IntegrityMismatchFinding,
  OutboxBacklogFinding,
  RetryExhaustionFinding,
  SilenceFinding,
  SlowSealFinding,
  StuckSagaFinding,
  TreasuryBreachFinding,
  VelocityAnomalyFinding,
  WebhookReplayStormFinding,
} from '#src/ops/detect.ts';

export {
  createSupervisor,
  defaultSupervisorConfig,
} from '#src/ops/supervisor.ts';
export type {
  SagaSource,
  Supervisor,
  SupervisorConfig,
  SupervisorDeps,
} from '#src/ops/supervisor.ts';
