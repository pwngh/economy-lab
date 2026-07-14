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

// Node-only globals banned from the core, which targets the cross-runtime surface (Node, Bun,
// Deno, CF Workers). Each entry's message names the injected replacement.
const BANNED_GLOBALS = [
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
    message: 'Use the injected Scheduler, not raw timers.',
  },
  {
    name: 'setTimeout',
    message: 'Use the injected Scheduler/Clock, not raw timers.',
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

// Node-only module imports banned from the core; the adapter/engine layers wrap them instead.
const BANNED_IMPORTS = {
  paths: [
    {
      name: 'node:crypto',
      message: 'Use the injected Digest/Signer over crypto.subtle.',
    },
    {
      name: 'node:http',
      message: 'Use the Fetch handler (Request → Response) over node:http.',
    },
  ],
  patterns: [
    {
      group: ['node:*'],
      message: 'The core targets the WinterCG surface; node:* is adapter-only.',
    },
  ],
};

// Layering invariant 1: src/ must not import test or dev-script code. `regex` rather than
// `group` because group patterns are gitignore-style, where a leading `#` is a comment that
// matches nothing — `#test/**` would never fire.
const NON_SHIPPED_IMPORTS = [
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

// Layering invariant 2: the optional drivers load via dynamic import() from the composition
// root, so an unused peer dependency never loads. no-restricted-imports ignores dynamic
// import(), so those legitimate sites stay valid while static imports are refused.
const OPTIONAL_DRIVER_IMPORTS = [
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
  // apps/ has its own build/lint tooling, so it stays outside this gate. The vendored @pwngh/money
  // amalgamation is kept byte-identical to upstream; its embedded selfTest is the drift guard, not
  // this config's rules.
  {
    ignores: [
      'node_modules/**',
      'dist-site/**',
      'apps/**',
      'src/money.vendored.ts',
      'src/db.vendored.ts',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  n.configs['flat/recommended-module'],

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
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
      // False positive: the rule treats the cross-runtime `crypto` global, used on purpose, as
      // Node's experimental node:crypto and warns it may be unsupported.
      'n/no-unsupported-features/node-builtins': 'off',
      // Keep functions small enough to read top to bottom on one screen.
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

  // The core targets the WinterCG surface, so Node-only globals and node:* imports are banned
  // here. Both layering invariants apply.
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

  // The adapter/engine layers wrap Node APIs, so the node:* and Node-global bans lift here.
  // They are still shipped code, so both layering invariants remain.
  {
    files: ['src/adapters/**/*.ts', 'src/engines/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: OPTIONAL_DRIVER_IMPORTS, patterns: NON_SHIPPED_IMPORTS },
      ],
    },
  },

  // Tests run long (AAA narratives) and nest deep (adapter-matrix suites), so relax only the
  // function-size and nesting limits. Every other rule still applies.
  {
    files: ['test/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-nested-callbacks': 'off',
    },
  },
);
