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
 * The bundled in-memory and HTTP adapters, plus the runtime services.
 *
 * @module adapters
 */

// This file gathers the built-in port implementations that are safe to load eagerly. A host
// composing its own Ports bag by hand (rather than through openPorts) finds the batteries in one
// place. Some adapters are absent by design. The SQL engines and the Redis and SQS adapters carry
// their own packages: @pwngh/economy-postgres, @pwngh/economy-mysql, @pwngh/economy-redis, and
// @pwngh/economy-sqs. The edge and payee adapters belong to the provider boundary.

// Stores.
export { memoryStore } from '#src/adapters/memory.ts';
// The ledger the memory store holds, carrying the two seeding and tampering hooks an integrity
// demo drives. Naming it is the only way to reach them without an unchecked cast.
export type { MemoryLedger } from '#src/adapters/memory.ts';

// Caches.
export { memoryCache } from '#src/adapters/memory-cache.ts';
export { memoryRateLimiter } from '#src/adapters/memory-rate-limit.ts';
// The window every limiter counts, and the refusal every limiter owes it. An out-of-tree limiter
// refuses the same policies with these, the way an out-of-tree dispatcher throws the same fault
// with `transportFault`.
export { assertRatePolicy } from '#src/adapters/rate-policy.ts';
export type { RatePolicy } from '#src/adapters/rate-policy.ts';

// Dispatchers.
export { httpDispatcher } from '#src/adapters/http-dispatcher.ts';
export { httpAnchor } from '#src/adapters/http-anchor.ts';

// Hosting. createServer answers Request with Response, which Bun and Deno serve directly; Node
// is the runtime that cannot, so the bridge onto node:http ships here rather than in every
// host that needs one. node:http is loaded inside the call, so this door stays importable on
// the runtimes that have no such module.
export { serveNode } from '#src/adapters/http-node.ts';
export type { NodeServer, ServeNodeOptions } from '#src/adapters/http-node.ts';

// The two helpers every transport shares: the one canonical event body, and the retryable fault a
// failed hand-off throws. An out-of-tree dispatcher speaks the same wire and the same error with
// these.
export { encodeEvent } from '#src/adapters/event-wire.ts';
export { transportFault } from '#src/adapters/transport-fault.ts';

// Processors. memoryProcessor is the in-memory double for demos and tests. httpProcessor is the
// real HTTP payout provider.
export { memoryProcessor, httpProcessor } from '#src/adapters/processor.ts';

// Rates and pricing are the two required external ports that ship with a built-in constructor.
export { configuredRates } from '#src/adapters/rates.ts';
export { flatFee } from '#src/pricing.ts';

// The entitlements read-model is a bitset cache over the entitlement store. It is opt-in for a
// host with many SKUs per user.
export { cachedEntitlements } from '#src/adapters/entitlement-bitset.ts';

// Runtime ports cover clocks, id generators, hashers, signers, and loggers. The fixed and
// sequential variants make a run reproducible. systemRuntime (on the package root) bundles the
// production four.
export { systemClock, fixedClock } from '#src/runtime.ts';
export { randomIds, sequentialIds } from '#src/runtime.ts';
export { systemDigest } from '#src/runtime.ts';
export { systemSigner, signingPublicKeyHex } from '#src/runtime.ts';
export { jsonlLogger, silentLogger } from '#src/runtime.ts';
export { silentMeter } from '#src/runtime.ts';
