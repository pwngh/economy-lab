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

import { expect, it } from 'vitest';

import { creditsDisplay } from '~/views';
import { toAmount } from '#src/money.ts';

it('renders a balance past 2^53 minor units exactly, where Number would round', () => {
  // 2^53 + 1 minor: the first integer a float cannot represent.
  const minor = 9_007_199_254_740_993n;
  expect(String(Number(minor))).not.toBe(minor.toString()); // the rounding this guards against
  expect(creditsDisplay(toAmount('CREDIT', minor))).toBe(
    '90,071,992,547,409.93',
  );
});

it('renders small, zero, and negative figures in the fmtAmount shape', () => {
  expect(creditsDisplay(toAmount('CREDIT', 0n))).toBe('0.00');
  expect(creditsDisplay(toAmount('CREDIT', 123_456n))).toBe('1,234.56');
  expect(creditsDisplay(toAmount('CREDIT', -5n))).toBe('-0.05');
  expect(creditsDisplay(toAmount('USD', 100n))).toBe('1.00');
});
