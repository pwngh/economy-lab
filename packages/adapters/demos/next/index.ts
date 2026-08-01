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

// The face alone leaves every sweep stopped — payouts never settle and the outbox never relays.
// This holds the sweeps only while the Node server stays up. On a serverless deployment nothing
// outlives the request, so run the worker role in a process of its own.
app.startWorker();

const route = (request: Request): Promise<Response> => app.handler(request);

// One export per method the router dispatches. A method missing here is a 405 on a route the
// economy serves everywhere else.
export const GET = route;
export const POST = route;
export const PUT = route;
export const DELETE = route;
export const OPTIONS = route;
