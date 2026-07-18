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

// One guided-click experiment, configured here and nowhere else: the id names the run and the
// steps name the controls in click order. The fresh economy seeds payouts in Submitted, so the
// loop teaches the full cycle — settle what waits, advance the day, run the worker, settle what
// it submitted. Off by default; the Controls toggle turns it on, and while on the walk loops.
// Each click advances one step — no timers, so the pulse can only sit on the one control whose
// turn it is. Position and the toggle live in localStorage, like the theme; a storage failure
// reads as off.

const EXPERIMENT = 'payout-flow-1';
const STEPS = ['settle', 'day', 'jobs', 'settle'] as const;

export type HintControl = (typeof STEPS)[number];

const KEY = `elab_hint_${EXPERIMENT}`;
const ON_KEY = 'elab_hints_on';

export function hintsOn(): boolean {
  try {
    return localStorage.getItem(ON_KEY) === '1';
  } catch {
    return false;
  }
}

export function setHintsOn(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(ON_KEY, '1');
    } else {
      localStorage.removeItem(ON_KEY);
    }
  } catch {
    // A blocked store just leaves hints off.
  }
}

function position(): number {
  try {
    const v = Number(localStorage.getItem(KEY) ?? '0');
    return Number.isInteger(v) && v >= 0 ? v % STEPS.length : 0;
  } catch {
    return 0;
  }
}

export function hintOn(control: HintControl): boolean {
  return hintsOn() && STEPS[position()] === control;
}

export function advanceHint(control: HintControl): void {
  if (!hintOn(control)) {
    return;
  }
  try {
    localStorage.setItem(KEY, String(position() + 1));
  } catch {
    // A blocked store just leaves hints off.
  }
}
