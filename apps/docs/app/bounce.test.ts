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

// The deploy-critical console deep-link bounce, exercised as the exact bytes that ship: a static
// host 404s /console/* to this page, whose inline script stashes the intended URL and replaces to
// the console shell (entry.client.tsx restores it). Running the real CONSOLE_BOUNCE string with an
// injected location and sessionStorage proves the stash keeps search and hash and normalizes the
// no-trailing-slash form — the parts that only a browser would otherwise catch.
import { describe, expect, test } from 'vitest';

import { CONSOLE_BOUNCE } from './routes/not-found';

function runBounce(loc: { pathname: string; search?: string; hash?: string }) {
  const stash: Record<string, string> = {};
  const replaced: string[] = [];
  const location = {
    pathname: loc.pathname,
    search: loc.search ?? '',
    hash: loc.hash ?? '',
    replace: (url: string) => replaced.push(url),
  };
  const sessionStorage = {
    setItem: (key: string, value: string) => {
      stash[key] = value;
    },
  };
  // The script reads bare `location` / `sessionStorage`; passing them as parameters scopes those
  // names to the mocks without touching the real globals.
  new Function('location', 'sessionStorage', CONSOLE_BOUNCE)(location, sessionStorage);
  return { stash, replaced };
}

describe('console deep-link bounce', () => {
  test('stashes a deep link with its search and hash, then replaces to the shell', () => {
    const { stash, replaced } = runBounce({
      pathname: '/console/ledger',
      search: '?from=docs',
      hash: '#race',
    });
    expect(stash.elab_redirect).toBe('/console/ledger?from=docs#race');
    expect(replaced).toEqual(['/console/']);
  });

  test('normalizes the bare /console form before stashing', () => {
    const { stash, replaced } = runBounce({ pathname: '/console' });
    expect(stash.elab_redirect).toBe('/console/');
    expect(replaced).toEqual(['/console/']);
  });

  test('leaves a non-console 404 alone', () => {
    const { stash, replaced } = runBounce({ pathname: '/economy/nope' });
    expect(stash.elab_redirect).toBeUndefined();
    expect(replaced).toEqual([]);
  });
});
