/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The engine's own HTTP service, mounted in the console: a submission here carries one operation
 * as its JSON body, runs it through this tab's ledger via the same createServer (src/server.ts)
 * the engine exposes when run standalone, and returns the wire response. The Developers page's
 * runner posts here, so a wire operation and the UI drive the one ledger.
 */

import { getEngine } from '~/engine';
import type { Route } from './+types/submit';

// The wire Response is unpacked to plain data: the status and the decoded JSON body, exactly what
// the runner renders. (There is no server to curl — the service runs in the tab.)
async function runWire(request: Request) {
  const eco = await getEngine();
  const response = await eco.httpFetch(request);
  return { status: response.status, body: await response.json() };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  return runWire(request);
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  return runWire(request);
}
