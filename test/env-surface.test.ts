/// <reference types="node" />
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

// The environment surface is enumerable: every family that reads env exports the key list it
// reads, and this test holds .env.example to the union — every declared name must be documented,
// and every documented name must belong to a declared family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  OPTIONAL_SECRETS,
  REQUIRED_SECRETS,
  SERVICE_URL_KEYS,
  STORE_URL_KEYS,
} from '#src/env.ts';
import { CONFIG_KEYS, DECLINE_KEYS, SECRET_KEYS } from '#src/config.ts';
import { BENCH_KEYS } from '#scripts/support/harness.ts';
import { EXTERNALS_KEYS, SERVER_KEYS } from '#scripts/support/server-env.ts';
import { TILIA_KEYS } from '#scripts/support/edge-host.ts';
import { TASKQ_KEYS } from '#scripts/support/taskq-host.ts';
import { OPS_KEYS } from '#scripts/support/ops-host.ts';

// Names read by entry scripts that execute on import (so their lists can't live in the script):
// DEMO_RESET is scripts/demo.ts's reset flag; the two BENCH_QUEUE_* names are scripts/bench-queue.ts's
// (mirrored by its exported BENCH_QUEUE_KEYS, which this test can't import without running the script);
// BENCH_HOT_CONCURRENCY is scripts/bench-scale.ts's hot-seller depth sweep.
const SCRIPT_KEYS = [
  'DEMO_RESET',
  'BENCH_QUEUE',
  'BENCH_QUEUE_COOLDOWN_MS',
  'BENCH_HOT_CONCURRENCY',
] as const;

// Names .env.example documents that the lab never parses itself: the AWS SDK reads these from the
// environment directly (scripts/smoke.ts seeds them for LocalStack).
const SDK_PASSTHROUGH = new Set([
  'AWS_REGION',
  'AWS_ENDPOINT_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
]);

const DECLARED = new Set<string>([
  ...STORE_URL_KEYS,
  ...SERVICE_URL_KEYS,
  ...REQUIRED_SECRETS,
  ...OPTIONAL_SECRETS,
  ...CONFIG_KEYS,
  ...SECRET_KEYS,
  ...DECLINE_KEYS,
  ...SERVER_KEYS,
  ...EXTERNALS_KEYS,
  ...BENCH_KEYS,
  ...TILIA_KEYS,
  ...TASKQ_KEYS,
  ...OPS_KEYS,
  ...SCRIPT_KEYS,
]);

// Every `NAME=` at the start of a line, active or commented out, is a documented name.
function documentedNames(example: string): Set<string> {
  const names = new Set<string>();
  for (const line of example.split('\n')) {
    const match = /^#?\s?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) {
      names.add(match[1]!);
    }
  }
  return names;
}

test('.env.example documents exactly the declared env surface', async () => {
  const example = await readFile(
    new URL('../.env.example', import.meta.url),
    'utf8',
  );
  const documented = documentedNames(example);

  const undocumented = [...DECLARED]
    .filter((name) => !documented.has(name))
    .sort();
  assert.deepEqual(
    undocumented,
    [],
    `declared in code but missing from .env.example: ${undocumented.join(', ')}`,
  );

  const undeclared = [...documented]
    .filter((name) => !DECLARED.has(name) && !SDK_PASSTHROUGH.has(name))
    .sort();
  assert.deepEqual(
    undeclared,
    [],
    `documented in .env.example but no family declares it: ${undeclared.join(', ')}`,
  );
});
