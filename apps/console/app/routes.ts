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

import {
  type RouteConfig,
  index,
  layout,
  route,
} from '@react-router/dev/routes';

// Every page lives under one chrome layout (sidebar nav + persistent Simulation panel).
// The layout owns the shared loader (sim settings + a few headline figures) and hosts the
// <Outlet/> each page renders into. The simulation + record actions are their own resource
// routes the panel/forms post to with fetchers, then revalidate.
export default [
  layout('routes/_chrome.tsx', [
    index('routes/overview.tsx'),
    route('accounts', 'routes/accounts.tsx'),
    route('ledger', 'routes/ledger.tsx'),
    route('payouts', 'routes/payouts.tsx'),
    route('integrity', 'routes/integrity.tsx'),
    route('developers', 'routes/developers.tsx'),
  ]),
  // Resource routes (no UI of their own): the persistent panel and the record modal post
  // here, then the page revalidates so the live engine state re-renders.
  route('actions/simulate', 'routes/actions.simulate.tsx'),
  route('actions/record', 'routes/actions.record.tsx'),
] satisfies RouteConfig;
