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

// Globals that exist only in Node, banned from the core library code. The core
// targets the APIs common to every modern JS runtime (Node, Bun, Deno, Cloudflare
// Workers) so it stays portable, so each of these has a portable replacement that
// is passed in instead: time comes from an injected Clock, randomness and hashing
// from the standard crypto.subtle, and raw bytes from Uint8Array. Each entry below
// names the forbidden global and the error message ESLint shows when it is used.
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

// Node-only module imports banned from the core library code. Only the adapter
// layer (src/adapters/) is allowed to import these directly; it wraps each one
// behind a portable interface that the rest of the code depends on instead.
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

// Layering invariant 1 — the shipped library (src/) must never import test or dev-script code.
// Those trees exist only to exercise and operate the library; importing them would drag test-only
// helpers and CLI wiring into a production bundle. Only static `import`/`export from` are matched
// (the intent is to keep this code out of the module graph entirely). These use `regex` rather than
// `group`: group patterns are gitignore-style, where a leading `#` is a comment and matches nothing,
// so a glob like `#test/**` would silently never fire — `regex` matches the alias literally.
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

// Layering invariant 2 — the optional database/cache/queue drivers (pg, mysql2, ioredis,
// @aws-sdk/client-sqs) are marked optional in peerDependenciesMeta and are loaded ONLY via dynamic
// import() in the composition root (src/index.ts), so an unused driver is never required or bundled.
// Forbid STATIC imports of them across the shipped library to keep that guarantee — `no-restricted-
// imports` does not flag dynamic import(), so the legitimate `await import(...)` sites stay valid.
let OPTIONAL_DRIVER_IMPORTS = [
  '#src/adapters/postgres.ts',
  '#src/adapters/mysql.ts',
  '#src/adapters/redis.ts',
  '#src/adapters/sqs.ts',
].map((name) => ({
  name,
  message:
    'Load optional drivers via dynamic import() so an unused peer dependency never loads (§ peerDependenciesMeta).',
}));

export default tseslint.config(
  // `apps/` holds standalone front-end apps (the Remix console) with their own build and lint
  // tooling, separate from the library's core and test code, so they stay outside this lint
  // gate alongside the other non-core UI/asset dirs.
  {
    ignores: ['legacy/**', 'node_modules/**', 'assets/**', 'viz/**', 'apps/**'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  n.configs['flat/recommended-module'],

  // Shared rules applied to every .ts file in the project: coding-style
  // conventions plus limits that keep functions small and readable.
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
      // eslint-plugin-n cannot resolve imports written with a `.ts` extension, so it
      // would wrongly report them as missing. The TypeScript compiler handles
      // resolution here (via its allowImportingTsExtensions option), so turn off the
      // plugin's import-resolution rules that would otherwise conflict.
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-extraneous-import': 'off',
      // This rule treats the standard cross-runtime `crypto` global (which the core
      // uses on purpose) as Node's experimental node:crypto and warns it may be
      // unsupported. We know it is available: the TypeScript types and a runtime smoke
      // test confirm it, and the ban further down already blocks Node-only globals.
      // So turn this rule off to stop the false positive.
      'n/no-unsupported-features/node-builtins': 'off',
      // Limits that keep each function readable: small enough to follow top to bottom
      // and fit on one screen. complexity caps the number of branching paths.
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

  // Core library under src/, excluding the adapter layer (src/adapters/). The core targets the
  // portable WinterCG surface, so Node-only globals and node:* imports are banned here; tests and
  // adapters are not matched and stay free to use Node APIs. The two layering invariants above also
  // apply: no test/dev-script code, and no static imports of the optional drivers. (The drivers and
  // the wire codec that index.ts/server.ts legitimately reach for are not on these lists, so those
  // seams stay valid.)
  {
    files: ['src/**/*.ts'],
    ignores: ['src/adapters/**'],
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

  // The adapter layer (src/adapters/) wraps Node-only APIs, so the node:* and Node-global bans do
  // not apply. But it is still shipped library code, so the layering invariants do: no adapter may
  // import test/dev-script code, and the optional drivers must stay behind dynamic import().
  {
    files: ['src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: OPTIONAL_DRIVER_IMPORTS, patterns: NON_SHIPPED_IMPORTS },
      ],
    },
  },

  // Test files (test/**) are linear arrange-act-assert narratives, and the differential/conformance
  // suites iterate over the adapter matrix (each engine × each invariant), so a single test() body
  // legitimately runs long and nests a few callbacks deep. The function-size and nesting limits above
  // are tuned for production code in src/; relaxing only those two here keeps a scenario readable as one
  // piece instead of fragmenting it to satisfy a heuristic. Every correctness rule (no-unused-vars,
  // complexity, no-restricted-* etc.) still applies to tests unchanged.
  {
    files: ['test/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-nested-callbacks': 'off',
    },
  },
);
