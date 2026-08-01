/**
 * @pwngh/economy-ui
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// Positive control for invocation.test.tsx, run only by it: renders JSX,
// then fails on purpose. Named outside the `*.test.tsx` glob so no suite picks
// it up on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'react-dom/server';

test('control: JSX renders and a deliberate failure surfaces as itself', () => {
  const html = renderToString(<strong>CREDIT:480.00</strong>);
  assert.equal(html, '<strong>CREDIT:480.00</strong>');
  assert.fail('control: intentional failure');
});
