/**
 * @pwngh/economy-redis
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

/** Builds the read-through `Cache`, opening its own connection from a URL. */
export { redisCache } from './redis.js';

/** Builds the fixed-window `RateLimiter`, opening its own connection from a URL. */
export { redisRateLimiter } from './redis.js';

export type { RedisClient, RedisCounterClient } from './redis.js';
