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

// Browser-cleanliness gate: the main entry must bundle for the browser with no aliases or
// stubs, so "the in-memory economy runs in your browser" is a package property. Only specifiers
// already confined behind runtime guards may stay external; anything else node:-flavored is a
// leak this gate exists to stop.

import { build } from 'esbuild';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

// Each entry is reachable only behind a runtime guard (digest.ts's probe, the selection-time
// store/cache/dispatcher imports). Growing this list is a boundary decision, not a fix.
const GUARDED_EXTERNALS = [
  'node:crypto', // digest.ts probes it and falls back to Web Crypto
  'node:fs/promises', // engines read their schema files; engines load only when selected
  'node:url',
  'pg',
  'mysql2',
  'ioredis',
  '@aws-sdk/client-sqs',
];

let result = null;
try {
  result = await build({
    entryPoints: [join(ROOT, 'src/index.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    external: GUARDED_EXTERNALS,
    logLevel: 'silent',
  });
} catch (error) {
  console.error(
    'check-browser-entry failed — src/index.ts no longer bundles for the browser without aliases:',
  );
  for (const message of error.errors ?? [{ text: String(error) }]) {
    console.error(
      `  ${message.text}${message.location ? `  (${message.location.file}:${message.location.line})` : ''}`,
    );
  }
  process.exitCode = 1;
}

if (result !== null) {
  // A new `node:` import normally fails the build above; this catches one smuggled in through
  // an externalized package or a future esbuild behavior change.
  const output = result.outputFiles[0].text;
  const found = new Set(
    [...output.matchAll(/["'](node:[a-z/_-]+)["']/g)].map((m) => m[1]),
  );
  const leaked = [...found].filter((s) => !GUARDED_EXTERNALS.includes(s));
  if (leaked.length > 0) {
    console.error(
      `check-browser-entry failed — node: specifiers outside the guarded set: ${leaked.join(', ')}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `check-browser-entry passed — src/index.ts bundles for the browser (${Math.round(output.length / 1024)} KiB, ${found.size} guarded node: externals).`,
    );
  }
}
