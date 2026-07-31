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

// Layering invariant 2: the backends are their own packages, so the lab must not name one. A
// static or dynamic import of any of them is the cycle the split exists to prevent.
const BACKEND_PACKAGES = {
  regex: '^@pwngh/economy-(postgres|mysql|redis|sqs)',
  message:
    'The lab must not import a backend package; the backend arrives through Ports.',
};

// Layering invariant 3: the supervisor observes the core through its ports; the core never
// knows it is observed. Leaving src/supervisor out of the composition is the off switch.
const SUPERVISOR_BOUNDARY = {
  regex: '^#src/supervisor/',
  message:
    'The core must not import src/supervisor; the supervisor is opt-in host composition.',
};

export default tseslint.config(
  // apps/ has its own build/lint tooling, so it stays outside this gate, including apps/support's
  // trivial browser-build shim stubs the apps alias to (bundled by vite, never imported by name).
  // docs/ holds the generated API reference. Typedoc wipes and rebuilds it on every run, so it
  // stays out as well. Only compiled output is skipped under packages/; their sources and tests
  // are governed here. Every entry here is generated output or another tool's territory: no
  // authored file under src/ or test/ is ignored, and test/toolchain-shape.test.ts holds that.
  {
    ignores: [
      'node_modules/**',
      'dist-site/**',
      'dist/**',
      '.build-tmp/**',
      'docs/**',
      'apps/**',
      'packages/*/dist/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  n.configs['flat/recommended-module'],

  // `.tsx` is named alongside `.ts` in every block below. `packages/ui/src/lib/react.tsx` is the
  // only one in the tree, and a `**/*.ts` glob skips it in silence — `eslint .` reported the whole
  // repo clean while never opening a file on a published door.
  {
    files: ['**/*.ts', '**/*.tsx'],
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
      // ignoreRestSiblings keeps the `const { dropped: _x, ...rest } = obj` idiom, which has to
      // name a property in order to leave it out of the rest object.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // eslint-plugin-n can't resolve `.ts`-extension imports and reports them as missing. TS handles
      // resolution (allowImportingTsExtensions), so turn off the plugin's import-resolution rules.
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-extraneous-import': 'off',
      // False positive: the rule treats the cross-runtime `crypto` global, used on purpose, as
      // Node's experimental node:crypto and warns it may be unsupported.
      'n/no-unsupported-features/node-builtins': 'off',
      // Branch count, nesting and arity, measured directly. There is deliberately no
      // line-count rule: length is a proxy for these, and Remix ships a 1037-line file.
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
      'max-nested-callbacks': ['error', 3],
    },
  },

  // The core targets the WinterCG surface, so Node-only globals and node:* imports are banned
  // here. Both layering invariants apply.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/adapters/**', 'src/engines/**', 'src/supervisor/**'],
    rules: {
      'no-restricted-globals': ['error', ...BANNED_GLOBALS],
      'no-restricted-imports': [
        'error',
        {
          paths: BANNED_IMPORTS.paths,
          patterns: [
            ...BANNED_IMPORTS.patterns,
            ...NON_SHIPPED_IMPORTS,
            SUPERVISOR_BOUNDARY,
            BACKEND_PACKAGES,
          ],
        },
      ],
    },
  },

  // The adapter/engine layers wrap Node APIs, so the node:* and Node-global bans lift here.
  // They are still shipped code, so both layering invariants remain, and so does the boundary.
  {
    files: ['src/adapters/**/*.ts', 'src/engines/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...NON_SHIPPED_IMPORTS,
            SUPERVISOR_BOUNDARY,
            BACKEND_PACKAGES,
          ],
        },
      ],
    },
  },

  // src/supervisor is shipped code on the WinterCG surface like the core; only its own boundary
  // lifts, so the supervisor may import its own modules.
  {
    files: ['src/supervisor/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...BANNED_GLOBALS],
      'no-restricted-imports': [
        'error',
        {
          paths: BANNED_IMPORTS.paths,
          patterns: [
            ...BANNED_IMPORTS.patterns,
            ...NON_SHIPPED_IMPORTS,
            BACKEND_PACKAGES,
          ],
        },
      ],
    },
  },

  // Adapter-matrix suites nest deep, so relax only nesting. Every other rule still applies.
  {
    files: [
      'test/**/*.ts',
      'packages/*/test/**/*.ts',
      'packages/*/test/**/*.tsx',
    ],
    rules: {
      'max-nested-callbacks': 'off',
    },
  },

  // A package's `bin` names compiled output (dist/*.js), so n/hashbang cannot see that a
  // src/*.ts file becomes that bin, and reports its shebang as unnecessary. tsc copies the
  // shebang from source into dist, so deleting it would break the published executable.
  // convertPath maps src back to dist, which makes the rule resolve the real bin and stay on:
  // a shebang on a non-bin source file is still an error.
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    rules: {
      'n/hashbang': [
        'error',
        { convertPath: { 'src/**/*.ts': ['^src/(.+)\\.ts$', 'dist/$1.js'] } },
      ],
    },
  },

  // The register's two naming clauses, as a rule rather than a habit: a rename with nothing
  // behind it comes back with the next package. Root `src/` is deliberately outside the scope —
  // its four `noOverdraft` sites are a ledger domain flag in a different tree.
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Identifier[name='opts']",
          message: 'Call it `options`, and give its type a name.',
        },
        {
          selector: 'Identifier[name=/^no[A-Z]/]',
          message:
            'Booleans are bare adjectives: `worker`, not `noWorker` — a negated name reads backwards at every call site.',
        },
      ],
    },
  },

  // Process entry points: a bin, a bin fixture the suite spawns and reads an exit code from,
  // and the dev scripts. n/no-process-exit exists to stop library code taking the exit
  // decision away from its caller, and the library layer honours it — runEconomy documents
  // that it never exits so a host can drive the CLI in-process. At the top of a process there
  // is no caller to defer to, and exiting is the contract. process.exitCode is not a
  // substitute here: the worker verb parks the event loop on a timer, so any handle left open
  // would hang the command instead of ending it.
  {
    files: [
      'packages/*/src/bin.ts',
      'packages/*/src/cli-entry.ts',
      'packages/*/test/support/entry.ts',
      'packages/*/test/support/dist-entry.js',
      'packages/*/scripts/**/*.ts',
    ],
    rules: {
      'n/no-process-exit': 'off',
    },
  },

  // Sample code a developer reads and copies: the example app and the scaffolder templates.
  // console.log is the idiom a reader expects there, and process.stdout.write would teach the
  // wrong thing. House code keeps the ban.
  {
    files: ['packages/*/example/**/*.ts', 'packages/*/templates/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
