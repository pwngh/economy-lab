/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * Redirect sanitizing: a mutation only ever returns to a same-origin path, never an off-site
 * location smuggled through the back field.
 */

import { expect, it } from 'vitest';

import { getEngine } from '~/engine.ts';
import { takeFlash } from '~/flash.ts';
import { clientAction as simulate } from '../app/routes/actions.simulate';
import { formPost } from './support';

it('a hostile back path is redirected to the root instead', async () => {
  await (await getEngine()).reset();
  takeFlash();

  // Both the protocol-relative `//host` and the backslash `/\host` form, which the browser
  // normalizes to `//host` and would follow off-site.
  for (const back of ['//evil.example/phish', '/\\evil.example/phish']) {
    const response = await formPost(simulate, {
      op: 'advance',
      days: '1',
      back,
    });

    expect(response.headers.get('location')).toBe('/');
    takeFlash();
  }
});
