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
 * Reads how a response was framed, off the socket.
 *
 * `fetch` decodes chunked transfer away, so a test holding a `Response` cannot tell a stated
 * content-length from a chunked stream. Every door that has to answer for its framing reads it
 * through here.
 *
 * TWO TREES READ THIS FILE: the lab's own rig, and `packages/adapters`, which reaches it by
 * relative path. It therefore imports `node:` builtins and nothing else. An import of the lab's
 * source would put a second copy of the lab in a package rig that already loads the built one,
 * and the package typechecks refuse it by hand: their `rootDir` reaches the repo, and their
 * compiler options do not accept the `.ts` specifiers the lab's own source is written in.
 */

import { get } from 'node:http';

/** The framing fields as they crossed the socket. */
export interface Framed {
  readonly contentLength: string | undefined;
  readonly transferEncoding: string | undefined;
  readonly bytes: number;
}

export const framingOf = (url: string): Promise<Framed> =>
  new Promise((resolve, reject) => {
    // agent: false sends `connection: close`, so no keep-alive socket outlives the probe.
    get(url, { agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          contentLength: res.headers['content-length'],
          transferEncoding: res.headers['transfer-encoding'],
          bytes: Buffer.concat(chunks).byteLength,
        }),
      );
    }).on('error', reject);
  });
