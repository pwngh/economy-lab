/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The chrome frame — sidebar, topbar clock and tickers, the guided-tour strip, and the theme and
 * live-mode controls — rendered through a router stub. It is the one significant component the page
 * suites never exercise (they axe-check page bodies); this covers its own markup and URL wiring.
 */

// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { createRoutesStub } from 'react-router';
import { describe, expect, it } from 'vitest';

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
  prove: {
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

function render(entry: string): string {
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
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={[entry]} />);
}

describe('chrome frame', () => {
  it('renders the sidebar nav, the clock, and both proof tickers', () => {
    const html = render('/');
    for (const item of ['Overview', 'Market', 'Payouts', 'Integrity']) {
      expect(html).toContain(item);
    }
    expect(html).toContain('day 0');
    expect(html).toContain('Backing');
    expect(html).toContain('proven on this load');
  });

  it('marks the live toggle and theme controls for assistive tech', () => {
    const html = render('/');
    expect(html).toContain(
      'aria-label="Live mode: advance the simulated clock automatically"',
    );
    // No stored theme in the stub, so Auto is the pressed option.
    for (const label of ['Light', 'Dark', 'Auto']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('role="timer"');
  });

  it('shows no tour strip without the tour param', () => {
    expect(render('/')).not.toContain('tour-caption');
  });

  it('opens the tour strip at the step named by ?tour', () => {
    const html = render('/?tour=0');
    expect(html).toContain('The one number this ledger defends');
    expect(html).toContain('1/7');
    expect(html).toContain('Next: Market');
  });

  it('ignores an out-of-range tour step', () => {
    expect(render('/?tour=99')).not.toContain('tour-caption');
  });
});
