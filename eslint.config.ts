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

import eslint from '@eslint/js';
import n from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';

// Node-only globals banned from the core. The core targets the cross-runtime surface (Node, Bun,
// Deno, CF Workers), so each has an injected replacement: time via Clock, randomness/hashing via
// crypto.subtle, raw bytes via Uint8Array. Each entry: forbidden global + ESLint message.
let BANNED_GLOBALS = [
  {
    name: 'Buffer',
    message: 'Use Uint8Array and src/bytes.ts; Buffer is Node-only (§9).',
  },
  {
    name: 'process',
    message: 'Inject Config at the edge; the core never reads process (§0.21).',
  },
  {
    name: 'setInterval',
    message: 'Use the injected Scheduler, not raw timers (#58).',
  },
  {
    name: 'setTimeout',
    message: 'Use the injected Scheduler/Clock, not raw timers (#58).',
  },
  {
    name: 'EventEmitter',
    message: 'The core emits via the Dispatcher port, not EventEmitter (§9).',
  },
  {
    name: 'performance',
    message:
      'Time via the injected Clock; performance.now diverges across runtimes (§0.12).',
  },
];

// Node-only module imports banned from the core. Only the Node-using layers (src/adapters/,
// src/engines/) import these directly, wrapping each behind a portable interface.
let BANNED_IMPORTS = {
  paths: [
    {
      name: 'node:crypto',
      message: 'Use the injected Digest/Signer over crypto.subtle (#15).',
    },
    {
      name: 'node:http',
      message:
        'Use the Fetch handler (Request → Response) over node:http (#7).',
    },
  ],
  patterns: [
    {
      group: ['node:*'],
      message:
        'The core targets the WinterCG surface; node:* is adapter-only (§9).',
    },
  ],
};

// Layering invariant 1: src/ must not import test or dev-script code, which would drag test helpers
// and CLI wiring into the production bundle. Matches static import/export from only. Uses `regex`,
// not `group`: group patterns are gitignore-style where a leading `#` is a comment matching nothing,
// so `#test/**` would never fire; `regex` matches the alias literally.
let NON_SHIPPED_IMPORTS = [
  {
    regex: '^#test/',
    message:
      'Production code (src/) must not import test code (#test/*); it is dev-only.',
  },
  {
    regex: '^#scripts/',
    message:
      'Production code (src/) must not import dev-script code (#scripts/*); it is dev-only.',
  },
];

// Layering invariant 2: the optional db/cache/queue drivers (pg, mysql2, ioredis,
// @aws-sdk/client-sqs) are optional in peerDependenciesMeta and loaded via dynamic import() in the
// composition root (src/index.ts), so an unused driver is never required or bundled. Forbid static
// imports across the library to keep that guarantee; no-restricted-imports does not flag dynamic
// import(), so legitimate `await import(...)` sites stay valid.
let OPTIONAL_DRIVER_IMPORTS = [
  '#src/engines/postgres.ts',
  '#src/engines/mysql.ts',
  '#src/adapters/redis.ts',
  '#src/adapters/sqs.ts',
].map((name) => ({
  name,
  message:
    'Load optional drivers via dynamic import() so an unused peer dependency never loads (§ peerDependenciesMeta).',
}));

export default tseslint.config(
  // `apps/` holds standalone front-end apps (the React Router console) with their own build/lint tooling,
  // so they stay outside this gate alongside the other non-core UI/asset dirs.
  {
    ignores: ['legacy/**', 'node_modules/**', 'assets/**', 'viz/**', 'apps/**'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  n.configs['flat/recommended-module'],

  // Shared rules for every .ts file: style conventions plus function-size limits.
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'off', // House style: prefer `let` over `const` for bindings.
      'no-var': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      // eslint-plugin-n can't resolve `.ts`-extension imports and reports them as missing. TS handles
      // resolution (allowImportingTsExtensions), so turn off the plugin's import-resolution rules.
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-extraneous-import': 'off',
      // This rule treats the cross-runtime `crypto` global (used by the core on purpose) as Node's
      // experimental node:crypto and warns it may be unsupported. It's available (TS types and a
      // runtime smoke test confirm it; the ban below already blocks Node-only globals). Off to stop
      // the false positive.
      'n/no-unsupported-features/node-builtins': 'off',
      // Keep functions small enough to read top to bottom on one screen; complexity caps branches.
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-lines-per-function': [
        'error',
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
      'max-params': ['error', 4],
      'max-nested-callbacks': ['error', 3],
    },
  },

  // Core library under src/, excluding the Node-using layers src/adapters/ and src/engines/. Targets
  // the WinterCG surface, so Node-only globals and node:* imports are banned here; tests, adapters,
  // and the database engines aren't matched and may use Node APIs. Both layering invariants apply: no
  // test/dev-script code, no static imports of the optional drivers. (The drivers and the wire codec
  // that index.ts/server.ts reach for aren't on these lists, so those seams stay valid.)
  {
    files: ['src/**/*.ts'],
    ignores: ['src/adapters/**', 'src/engines/**'],
    rules: {
      'no-restricted-globals': ['error', ...BANNED_GLOBALS],
      'no-restricted-imports': [
        'error',
        {
          paths: [...BANNED_IMPORTS.paths, ...OPTIONAL_DRIVER_IMPORTS],
          patterns: [...BANNED_IMPORTS.patterns, ...NON_SHIPPED_IMPORTS],
        },
      ],
    },
  },

  // The Node-using layers — adapters (cache/queue/transport) and engines (Postgres/MySQL) — wrap
  // Node-only APIs, so the node:* and Node-global bans don't apply. They're still shipped code, so
  // the layering invariants do: no test/dev-script imports, and the optional drivers stay behind
  // dynamic import().
  {
    files: ['src/adapters/**/*.ts', 'src/engines/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: OPTIONAL_DRIVER_IMPORTS, patterns: NON_SHIPPED_IMPORTS },
      ],
    },
  },

  // Tests run long and nest a few callbacks deep (AAA narratives; the conformance suites iterate the
  // adapter matrix), so relax only the function-size and nesting limits here. Every other rule still
  // applies to tests.
  {
    files: ['test/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-nested-callbacks': 'off',
    },
  },
);
