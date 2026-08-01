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

import { Hono } from 'hono';
import { createApp, withDev } from '@pwngh/economy-core';
import * as definition from '../economy.app.js';

export const app = await createApp(withDev(definition));

// The face alone leaves every sweep stopped — payouts never settle and the outbox never
// relays. One process serves both halves; a worker-role process calls this and nothing else.
app.startWorker();

const server = new Hono();
server.all('*', (c) => app.handler(c.req.raw));

export default server;
