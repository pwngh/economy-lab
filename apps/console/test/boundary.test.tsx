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

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { expect, it } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { ErrorBoundary } from '~/routes/ledger.tsx';
import Chrome from '../app/routes/_chrome';

const chromeData = {
  settings: {
    faultMode: false,
    maturityHorizonDays: 0,
    maxPayoutAttempts: 5,
    now: 0,
  },
  solvency: {
    userCredits: 0,
    backed: true,
    shortfallUsd: 0,
    trustCashUsd: 0,
    purchased: 0,
    earned: 0,
    promotional: 0,
  },
  health: {
    conserved: true,
    backed: true,
    noOverdraft: true,
    chainIntact: true,
    consistent: true,
    shortfallUsd: 0,
    driftCount: 0,
    allGreen: true,
  },
  reseeded: false,
};

it('a page loader throw leaves the chrome and sidebar alive', async () => {
  const Stub = createRoutesStub([
    {
      path: '/',
      Component: () => (
        <Chrome
          {...({ loaderData: chromeData } as unknown as Parameters<
            typeof Chrome
          >[0])}
        />
      ),
      children: [
        {
          index: true,
          loader: () => {
            throw new Error('boom');
          },
          ErrorBoundary,
          Component: () => null,
        },
      ],
    },
  ]);
  const el = document.createElement('div');
  document.body.append(el);
  await act(async () => {
    createRoot(el).render(<Stub />);
  });

  expect(el.textContent).toContain('Something went wrong');
  expect(el.textContent).toContain('Payouts');
  expect(el.textContent).toContain('Integrity');
});
