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

// The face alone leaves every sweep stopped — payouts never settle and the outbox never
// relays. One process serves both halves; a worker-role process calls this and nothing else.
app.startWorker();

export default {
  port: app.config.find((knob) => knob.key === 'PORT')!.value,
  fetch: (request: Request): Promise<Response> => app.handler(request),
};
