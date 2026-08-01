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

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App } from '@pwngh/economy-core';
import { toRequest, writeResponse } from '@pwngh/economy-core/internal';
import {
  openMount,
  mounted,
  type FetchLike,
  type Mountable,
  type MountOptions,
  type Mounted,
} from './mount.js';

export type ExpressMiddleware = (
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  next: (error?: unknown) => void,
) => Promise<void>;

// The request line joined onto a fixed host, which is the same join `toRequest` makes against
// the real one: a claim has to be decided on the exact path the economy would be asked for.
const pathOf = (req: IncomingMessage): string =>
  new URL(`http://mount.invalid${req.url ?? '/'}`).pathname;

/** Express (or any Connect-style) middleware. Answers the paths the app declares and calls
 *  `next()` for every other one, so the host's own routes and its own body parsing keep
 *  working — the stream of an unclaimed request is never touched. Mount it before a body
 *  parser, or give it `express.raw` scoped to the economy's paths: a consumed stream cannot
 *  verify a webhook signature. Mounting an app runs its background half too, and `close()` on
 *  the returned middleware ends both. */
export function economyExpress(
  app: App,
  options?: MountOptions,
): Mounted<ExpressMiddleware>;
export function economyExpress(handler: FetchLike): ExpressMiddleware;
export function economyExpress(
  app: Mountable,
  options: MountOptions = {},
): ExpressMiddleware | Mounted<ExpressMiddleware> {
  const mount = openMount(app, options);
  const middleware: ExpressMiddleware = async (req, res, next) => {
    try {
      if (!mount.claims(pathOf(req))) {
        next();
        return;
      }
      const buffered = Buffer.isBuffer(req.body)
        ? new Uint8Array(req.body)
        : undefined;
      await writeResponse(await mount.handler(toRequest(req, buffered)), res);
    } catch (error) {
      // Express 4 does not await a middleware, so a rejection here would otherwise be an
      // unhandled one and the request would never answer.
      next(error);
    }
  };
  return mounted(middleware, mount);
}
