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

import { redirectBack } from '~/flash';
import type { Route } from './+types/actions.actor';

// The acting-as switcher: localStorage names who the market forms submit as, so it survives
// navigation (the root loader re-reads it after every mutation). A junk value clears the override
// and falls back to natural.
export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const actor = String(form.get('actor') ?? '');
  const valid =
    actor === 'operator' ||
    actor === 'system' ||
    /^usr_[a-z0-9_]+$/.test(actor);
  if (valid) {
    localStorage.setItem('elab_actor', actor);
  } else {
    localStorage.removeItem('elab_actor');
  }
  return redirectBack(form);
}
