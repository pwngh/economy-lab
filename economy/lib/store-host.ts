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

// The ledger's own database, when the environment names one. `openPorts` reads DATABASE_URL to
// decide what it is *missing* and never to import a driver by scheme, so a deployment that names
// a database must also hand in the engine. These are the lines a host writes once, and this app
// is a host — the same three the acceptance matrix amends into a scaffolded project, kept here so
// this repository's own image can be pointed at a real engine rather than only at memory.
//
// Unset leaves the framework's own selection alone, which is the in-memory store: that is the
// posture the demos, the samples and a bare `economy dev` run on, and nothing here changes it.
//
// The engine package is imported only once its scheme is selected, so the default deployment
// loads neither driver.

import { describeEnv } from '#src/index.ts';

import type { EnvMap } from '#src/env.ts';
import type { Logger, Store } from '#src/ports.ts';

/** Which engine this environment selected, alongside the store it opened. */
export interface StoreHost {
  readonly engine: 'postgres' | 'mysql';
  readonly store: Store;
}

/**
 * Opens the store `DATABASE_URL` names, or resolves undefined when it names none. An unsupported
 * scheme is left to the framework: `openPorts` refuses it by name, and a second refusal here
 * would be a second reading of one rule.
 *
 * The store carries its own `close()`, so the pool it opened is released by `economy.close()`
 * like every other port this module hands in.
 */
export async function maybeStore(
  env: EnvMap,
  logger: Logger,
): Promise<StoreHost | undefined> {
  const { kind, url } = describeEnv(env).store;
  // The url is null for exactly the kinds excluded here, and the reader carries both readings, so
  // the null is refused rather than asserted away.
  if ((kind !== 'postgres' && kind !== 'mysql') || url === null) {
    return undefined;
  }
  const store =
    kind === 'postgres'
      ? await (await import('@pwngh/economy-postgres')).postgres(url)
      : await (await import('@pwngh/economy-mysql')).mysql(url);
  logger.log('info', 'store.opened', { engine: kind });
  return { engine: kind, store };
}
