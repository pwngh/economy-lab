/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The X-ray recorder: one generic Proxy over the facade capturing each call's name, arguments,
 * result summary, and timing — async across the whole promise, sync inline.
 */

import { expect, it } from 'vitest';

import { buildEngine } from '../app/economy';
import { recordCalls } from '../app/xray';

import type { RecordedCall } from '../app/xray';

it('records each engine call with args, a result summary, and a timing', async () => {
  const engine = await buildEngine();
  const sink: RecordedCall[] = [];
  const eco = recordCalls(engine, sink);

  // Async method: timed across the whole promise, real value returned through the proxy.
  const page = await eco.wallets({ offset: 0, limit: 8 });
  expect(page.total).toBeGreaterThan(0);
  expect(sink).toHaveLength(1);
  expect(sink[0].name).toBe('wallets');
  expect(sink[0].args).toBe('{ offset: 0, limit: 8 }');
  expect(sink[0].result).toMatch(/^\d+ total$/);
  expect(sink[0].id).toBe(0);
  expect(sink[0].ms).toBeGreaterThanOrEqual(0);

  // Sync method: recorded inline, in call order, with the next id.
  eco.settings();
  expect(sink).toHaveLength(2);
  expect(sink[1].name).toBe('settings');
  expect(sink[1].id).toBe(1);

  // prove() carries both `backed` and `allGreen`; the summary must be the specific allGreen.
  await eco.prove();
  expect(sink[2].name).toBe('prove');
  expect(sink[2].result).toMatch(/^allGreen=/);
});
