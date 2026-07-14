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

import { getEngine } from '../app/engine';
import { takeFlash } from '../app/flash';

import type { ConsoleEngine } from '../app/economy';

// The tab engine returned to its seed with no flash pending: the starting point of every suite.
export async function fresh(): Promise<{ eco: ConsoleEngine }> {
  const eco = await getEngine();
  await eco.reset();
  takeFlash();
  return { eco };
}

// Call a route clientAction/clientLoader in a test. The framework arg types (Route.Client*Args)
// carry fields a unit test does not build; the one `as never` that fills them lives here, so call
// sites — and the returned type — stay honest.
export function callRoute<T>(
  handler: (args: never) => T,
  request: Request,
  params: Record<string, string> = {},
): T {
  return handler({ request, params } as never);
}

// The common case: a form POST (url-encoded fields) to a route action. The request URL is a fixed
// stand-in — actions read formData, not the URL.
export function formPost<T>(
  handler: (args: never) => T,
  body: Record<string, string>,
): T {
  const request = new Request('http://console.test/action', {
    method: 'POST',
    body: new URLSearchParams(body),
  });
  return callRoute(handler, request);
}
