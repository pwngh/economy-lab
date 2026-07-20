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

import { transportFault } from '#src/adapters/transport-fault.ts';

import type { Anchor, Checkpoint, CallOptions } from '#src/ports.ts';

export interface HttpAnchorConfig {
  /**
   * The external log or store each sealed checkpoint is POSTed to. It must live outside the
   * ledger's database, or the anchor proves nothing.
   */
  url: string;

  /**
   * Supplies the `fetch` implementation. Defaults to the global `fetch`, which avoids any
   * node-specific dependency. Tests pass a stand-in.
   */
  fetch?: typeof fetch;
}

/**
 * Builds the {@link Anchor} that POSTs one sealed checkpoint to an external endpoint over HTTP,
 * the row as plain JSON. A network error or a non-2xx response throws a retryable
 * `PROVIDER.FAILURE`; the seal logs it and moves on, and the checkpoint id rides an
 * `Idempotency-Key` header so a later re-anchor of the same row dedupes at the receiver.
 */
export function httpAnchor(config: HttpAnchorConfig): Anchor {
  const send = config.fetch ?? fetch;

  return {
    publish: async (
      checkpoint: Checkpoint,
      options?: CallOptions,
    ): Promise<void> => {
      let response: Response;
      try {
        response = await send(config.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': checkpoint.id,
          },
          body: JSON.stringify(checkpoint),
          signal: options?.signal,
        });
      } catch (error) {
        throw transportFault('HTTP anchor request failed.', error);
      }
      if (!response.ok) {
        throw transportFault(
          `HTTP anchor returned a non-2xx status (${response.status}).`,
          undefined,
        );
      }
    },
  };
}
