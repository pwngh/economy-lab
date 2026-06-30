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
// Deno, CF Workers), so each banned global has an injected replacement: time comes from Clock,
// randomness and hashing from crypto.subtle, raw bytes from Uint8Array. Each entry pairs the
// forbidden global with the ESLint message shown when it is used.
let BANNED_GLOBALS = [
  {
    name: 'Buffer',
    message: 'Use Uint8Array and src/bytes.ts; Buffer is Node-only.',
  },
  {
    name: 'process',
    message: 'Inject Config at the edge; the core never reads process.',
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
    message: 'The core emits via the Dispatcher port, not EventEmitter.',
  },
  {
    name: 'performance',
    message:
      'Time via the injected Clock; performance.now diverges across runtimes.',
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
      message: 'The core targets the WinterCG surface; node:* is adapter-only.',
    },
  ],
};

// Layering invariant 1: src/ must not import test or dev-script code. Such an import would drag test
// helpers and CLI wiring into the production bundle. The rule matches only static import and export
// statements. It uses `regex` rather than `group` because group patterns are gitignore-style, where
// a leading `#` is a comment that matches nothing, so `#test/**` would never fire. The `regex` form
// matches the `#test/` alias literally.
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

// Layering invariant 2: the optional db, cache, and queue drivers (pg, mysql2, ioredis,
// @aws-sdk/client-sqs) are declared optional in peerDependenciesMeta. The composition root
// (src/index.ts) loads them via dynamic import(), so an unused driver is never required or bundled.
// Forbidding static imports across the library keeps that guarantee. no-restricted-imports does not
// flag dynamic import(), so legitimate `await import(...)` sites stay valid.
let OPTIONAL_DRIVER_IMPORTS = [
  '#src/engines/postgres.ts',
  '#src/engines/mysql.ts',
  '#src/adapters/redis.ts',
  '#src/adapters/sqs.ts',
].map((name) => ({
  name,
  message:
    'Load optional drivers via dynamic import() so an unused peer dependency never loads.',
}));

export default tseslint.config(
  // `apps/` holds standalone front-end apps (the React Router console) with their own build/lint tooling,
  // so they stay outside this gate alongside the other non-core UI/asset dirs.
  {
    ignores: ['legacy/**', 'node_modules/**', 'apps/**'],
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
      // This rule treats the cross-runtime `crypto` global, which the core uses on purpose, as Node's
      // experimental node:crypto and warns that it may be unsupported. The global is available: the TS
      // types and a runtime smoke test confirm it, and the ban below already blocks Node-only globals.
      // The rule is off to silence the false positive.
      'n/no-unsupported-features/node-builtins': 'off',
      // Keep functions small enough to read top to bottom on one screen. The complexity cap limits branches.
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

  // Core library under src/, excluding the Node-using layers src/adapters/ and src/engines/. The core
  // targets the WinterCG surface, so Node-only globals and node:* imports are banned here. Tests,
  // adapters, and the database engines are not matched and may use Node APIs. Both layering invariants
  // apply: no test or dev-script code, and no static imports of the optional drivers. The drivers and
  // the wire codec that index.ts and server.ts reach for are not on these lists, so those seams stay
  // valid.
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

  // The Node-using layers wrap Node-only APIs: the adapters cover cache, queue, and transport, and
  // the engines cover Postgres and MySQL. Because they wrap those APIs, the node:* and Node-global
  // bans do not apply here. They are still shipped code, so both layering invariants do apply: no
  // test or dev-script imports, and the optional drivers stay behind dynamic import().
  {
    files: ['src/adapters/**/*.ts', 'src/engines/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: OPTIONAL_DRIVER_IMPORTS, patterns: NON_SHIPPED_IMPORTS },
      ],
    },
  },

  // Tests run long and nest a few callbacks deep. The AAA narratives make them long, and the
  // conformance suites add nesting by iterating the adapter matrix. So relax only the function-size
  // and nesting limits here. Every other rule still applies to tests.
  {
    files: ['test/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-nested-callbacks': 'off',
    },
  },
);
