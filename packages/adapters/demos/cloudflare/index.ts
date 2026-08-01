/**
 * @pwngh/economy-adapters
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { createApp, withDev } from '@pwngh/economy-core';
import * as definition from '../economy.app.js';

export const app = await createApp(withDev(definition));

/**
 * Workers hold no long-lived process, so there is nothing here for a sweep timer to live in:
 * run the worker role in a process of its own, or drive it from a cron trigger, which is what
 * `scheduled` is. Wire the trigger in `wrangler.toml`:
 *
 * ```toml
 * [triggers]
 * crons = ["* * * * *"]
 * ```
 */
export default {
  fetch: (request: Request): Promise<Response> => app.handler(request),
  scheduled: async (): Promise<void> => {
    await app.worker?.sweep();
  },
};
