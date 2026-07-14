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

import { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

// A deep link on a static host 404s (only /console/index.html exists); the site's 404 page stashes
// the intended path and lands here, and this restores it before the router boots.
const stashed = sessionStorage.getItem('elab_redirect');
if (stashed !== null) {
  sessionStorage.removeItem('elab_redirect');
  history.replaceState(null, '', stashed);
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
