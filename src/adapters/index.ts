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

// The built-in port implementations that are safe to load eagerly, gathered so a host composing its
// own capability bundle by hand (rather than through capabilitiesFromEnv) has the batteries in one
// place. Absent by design: the SQL engines and the Redis and SQS adapters, which carry an optional
// peer dependency and so load only through a dynamic import (reach them at '/adapters/redis' and
// '/adapters/sqs'); and the edge and payee adapters, which belong to the provider boundary.

// Stores.
export { memoryStore } from '#src/adapters/memory.ts';

// Caches.
export { memoryCache } from '#src/adapters/memory-cache.ts';

// Dispatchers.
export { httpDispatcher } from '#src/adapters/http-dispatcher.ts';

// Processors: the in-memory double for demos and tests, and the real HTTP payout provider.
export { memoryProcessor, httpProcessor } from '#src/adapters/processor.ts';

// Rates and pricing: the two required external ports that ship with a built-in constructor.
export { configuredRates } from '#src/adapters/rates.ts';
export { flatFee } from '#src/pricing.ts';

// Entitlements read-model: a bitset cache over the entitlement store, opt-in for a host with many
// SKUs per user.
export { cachedEntitlements } from '#src/adapters/entitlement-bitset.ts';

// Runtime ports: clocks, id generators, hashers, signers, loggers. The fixed and sequential
// variants make a run reproducible; systemCapabilities bundles the production four.
export { systemClock, fixedClock } from '#src/runtime.ts';
export { randomIds, sequentialIds } from '#src/runtime.ts';
export { systemDigest } from '#src/runtime.ts';
export { systemSigner, signingPublicKeyHex } from '#src/runtime.ts';
export { jsonlLogger, noopLogger } from '#src/runtime.ts';
export { noopMeter } from '#src/runtime.ts';
export { systemCapabilities } from '#src/runtime.ts';
