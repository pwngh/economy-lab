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

import { redirect } from 'react-router';

import { getEngine } from '~/engine';
import type { Route } from './+types/submit';

// The runner posts one operation as JSON; the wire Response is unpacked to plain data — the status
// and the decoded JSON body, exactly what it renders. (There is no server to curl — the service
// runs in the tab.)
export async function clientAction({ request }: Route.ClientActionArgs) {
  const eco = await getEngine();
  const response = await eco.httpFetch(request);
  return { status: response.status, body: await response.json() };
}

// A direct GET navigation here (someone typing /submit) carries no operation and this resource
// route renders no page. Send them to the Developers page, which owns the runner that posts here.
export function clientLoader() {
  return redirect('/developers');
}
