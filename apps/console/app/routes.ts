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

// Every page lives under one chrome layout (sidebar nav + topbar), which owns the shared loader
// and hosts the <Outlet/>. Its derived route id is CHROME_ROUTE_ID (ui.tsx) — renaming the module
// must update both.
export default [
  layout('routes/_chrome.tsx', [
    index('routes/overview.tsx'),
    route('market', 'routes/market.tsx'),
    route('accounts', 'routes/accounts.tsx'),
    route('ledger', 'routes/ledger.tsx'),
    route('ledger/txn/:id', 'routes/ledger.txn.$id.tsx'),
    route('payouts', 'routes/payouts.tsx'),
    route('pipeline', 'routes/pipeline.tsx'),
    route('integrity', 'routes/integrity.tsx'),
    route('controls', 'routes/controls.tsx'),
    route('developers', 'routes/developers.tsx'),
  ]),
  // The engine's real HTTP service, bound to this tab's economy: a wire operation posted here runs
  // through the same ledger the UI drives. The Developers page's runner posts to it.
  route('submit', 'routes/submit.tsx'),
  // Resource routes (no UI): the topbar, forms, and switchers post here, then the page revalidates.
  route('actions/simulate', 'routes/actions.simulate.tsx'),
  route('actions/subscribe', 'routes/actions.subscribe.tsx'),
  route('actions/record', 'routes/actions.record.tsx'),
  route('actions/market', 'routes/actions.market.tsx'),
  route('actions/reverse', 'routes/actions.reverse.tsx'),
  route('actions/pipeline', 'routes/actions.pipeline.tsx'),
  route('actions/scenario', 'routes/actions.scenario.tsx'),
  route('actions/tamper', 'routes/actions.tamper.tsx'),
  route('actions/theme', 'routes/actions.theme.tsx'),
  route('actions/actor', 'routes/actions.actor.tsx'),
] satisfies RouteConfig;
