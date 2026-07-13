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

// Every page lives under one chrome layout (sidebar nav + Simulation panel), which owns the shared
// loader and hosts the <Outlet/>.
export default [
  layout('routes/_chrome.tsx', [
    index('routes/overview.tsx'),
    route('accounts', 'routes/accounts.tsx'),
    route('ledger', 'routes/ledger.tsx'),
    route('payouts', 'routes/payouts.tsx'),
    route('integrity', 'routes/integrity.tsx'),
    route('developers', 'routes/developers.tsx'),
  ]),
  // Resource routes (no UI): the panel and record form post here, then the page revalidates.
  route('actions/simulate', 'routes/actions.simulate.tsx'),
  route('actions/record', 'routes/actions.record.tsx'),
] satisfies RouteConfig;
