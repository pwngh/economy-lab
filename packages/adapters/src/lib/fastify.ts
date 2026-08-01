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

import type { IncomingMessage } from 'node:http';
import type { App } from '@pwngh/economy-core';
import { toRequest } from '@pwngh/economy-core/internal';
import {
  openMount,
  mounted,
  type FetchLike,
  type Mountable,
  type MountOptions,
  type Mounted,
} from './mount.js';

// The narrow structural slice of Fastify this plugin touches, so the published types need
// no fastify dependency.
interface FastifyLike {
  removeAllContentTypeParsers(): void;
  addContentTypeParser(
    type: string | RegExp,
    options: { parseAs: 'buffer' },
    parser: (
      req: unknown,
      body: Buffer,
      done: (err: null, body: Buffer) => void,
    ) => void,
  ): void;
  all(
    path: string,
    handler: (
      request: { raw: IncomingMessage; body?: unknown },
      reply: {
        status(code: number): unknown;
        header(key: string, value: string): unknown;
        send(payload?: Buffer): unknown;
      },
    ) => Promise<void>,
  ): void;
}

export type FastifyPlugin = (fastify: FastifyLike) => Promise<void>;

/**
 * A Fastify plugin: `await fastify.register(economyFastify(app))`. Inside the plugin's own
 * encapsulation every body parses to a raw buffer, so webhook signatures verify — the
 * override never leaks to the host's other routes. Mounting an app runs its background half
 * too, and `close()` on the returned plugin ends both.
 */
export function economyFastify(
  app: App,
  options?: MountOptions,
): Mounted<FastifyPlugin>;
export function economyFastify(handler: FetchLike): FastifyPlugin;
export function economyFastify(
  app: Mountable,
  options: MountOptions = {},
): FastifyPlugin | Mounted<FastifyPlugin> {
  const mount = openMount(app, options);
  const plugin: FastifyPlugin = async function economyPlugin(fastify) {
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser(
      /.*/,
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );
    fastify.all('*', async (request, reply) => {
      const raw = Buffer.isBuffer(request.body)
        ? new Uint8Array(request.body)
        : undefined;
      const response = await mount.handler(toRequest(request.raw, raw));
      reply.status(response.status);
      response.headers.forEach((v, k) => reply.header(k, v));
      // A null body is sent as one: an empty buffer would earn Fastify's own
      // `application/octet-stream`, and the economy said nothing about a content type.
      reply.send(
        response.body ? Buffer.from(await response.arrayBuffer()) : undefined,
      );
    });
  };
  return mounted(plugin, mount);
}
