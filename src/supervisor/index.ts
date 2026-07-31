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
 * The `./supervisor` entry point exposes an in-process supervisor over the lab's meter/logger
 * ports. The dependency runs one way — the supervisor imports the core, never the reverse.
 * Leaving it out of the composition is the off switch.
 *
 * @module supervisor
 * @see {@link https://economy-lab-docs.pages.dev/economy/ops/the-supervisor/ The supervisor}
 *   for the tier model, the signal path, and the per-signature runbooks.
 */

export {
  hashChainedAuditSink,
  jsonlAuditSink,
  verifyAuditChain,
} from '#src/supervisor/audit.ts';
export type {
  AuditChainReport,
  AuditPhase,
  AuditRecord,
  AuditSink,
  SignatureName,
} from '#src/supervisor/audit.ts';

export { createSupervisorRuntime } from '#src/supervisor/runtime.ts';
export type {
  Signal,
  SignalFeed,
  SupervisorRuntime,
} from '#src/supervisor/runtime.ts';

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
} from '#src/supervisor/detect.ts';
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
} from '#src/supervisor/detect.ts';

export {
  createSupervisor,
  createSupervisorFrom,
  defaultSupervisorConfig,
} from '#src/supervisor/supervisor.ts';
export type {
  SagaSource,
  Supervisor,
  SupervisorConfig,
  SupervisorPorts,
} from '#src/supervisor/supervisor.ts';
