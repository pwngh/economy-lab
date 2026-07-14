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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// axe cannot check color-contrast under jsdom (no canvas), so the a11y suite disables that rule.
// This asserts it directly instead: every text ink must clear WCAG AA (4.5:1) against every surface
// it renders on, in both the light and dark resolutions of its light-dark() pair.

const css = readFileSync(
  fileURLToPath(new URL('../app/app.css', import.meta.url)),
  'utf8',
);

function pair(token: string): [string, string] {
  const m = new RegExp(
    `${token}:\\s*light-dark\\(\\s*(#[0-9a-f]{6})\\s*,\\s*(#[0-9a-f]{6})\\s*\\)`,
    'i',
  ).exec(css);
  if (!m) {
    throw new Error(`token ${token} not found as a light-dark() hex pair`);
  }
  return [m[1], m[2]];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const TEXT = ['--ink', '--ink-2', '--ink-3'] as const;
const SURFACES = ['--paper', '--surface', '--inset'] as const;
const AA = 4.5;

describe('token contrast meets WCAG AA', () => {
  for (const scheme of [0, 1] as const) {
    const name = scheme === 0 ? 'light' : 'dark';
    for (const ink of TEXT) {
      for (const surface of SURFACES) {
        it(`${name}: ${ink} on ${surface}`, () => {
          const ratio = contrast(pair(ink)[scheme], pair(surface)[scheme]);
          expect(ratio).toBeGreaterThanOrEqual(AA);
        });
      }
    }
  }
});
