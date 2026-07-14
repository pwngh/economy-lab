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
import type { Route } from './+types/actions.theme';

// Theme lives in localStorage under 'theme' — the key the docs share — and the <html> class is
// set here directly; the boot script in root.tsx applies the same class before first paint on the
// next visit. "auto" clears both and defers to prefers-color-scheme.
export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const theme = String(form.get('theme') ?? '');
  const classes = document.documentElement.classList;
  classes.remove('theme-light', 'theme-dark');
  if (theme === 'light' || theme === 'dark') {
    localStorage.setItem('theme', theme);
    classes.add(`theme-${theme}`);
  } else {
    localStorage.removeItem('theme');
  }
  return redirectBack(form);
}
