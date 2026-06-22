import { fileURLToPath } from 'node:url';

import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

// Repo root, two levels up from this app. The engine core is imported with the
// repo-wide `#*` subpath alias (root package.json "imports": { "#*": "./*" }),
// e.g. `#src/economy.ts`. Node resolves that natively for the no-build library,
// but `#`-imports are scoped to the *nearest* package.json — which for this app
// is apps/console/package.json, not the repo root — so Vite/esbuild would not
// see the root mapping. Re-map `#<path>` -> `<repoRoot>/<path>` here so the same
// specifier resolves to the same engine file the root tsconfig resolves it to.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// This app's own source root. The `~/*` -> `./app/*` alias is declared in tsconfig "paths", but
// that only informs the type-checker — Vite needs its own resolver entry (below), or `~/x` imports
// fail at build/SSR time. Mapping it here makes the alias resolve the same way in both places.
const appDir = fileURLToPath(new URL('./app/', import.meta.url));

// The economy-lab core lives at ../../src and is imported with EXPLICIT `.ts` specifiers
// throughout (e.g. `import { createEconomy } from './economy.ts'`), the convention the
// no-build root library uses so Node's `--experimental-strip-types` can run it directly.
// Vite/esbuild resolve those fine on their own, but two things must be set for SSR:
//
//  1. `ssr.noExternal` — force the engine source through Vite's transform pipeline instead
//     of leaving it as a Node `external` require. Without this, the SSR bundle tries to
//     `require('../../src/economy.ts')` at runtime and Node can't load a `.ts` file from a
//     bundled context. Listing the source dir here makes Vite compile the TypeScript.
//
//  2. `server.fs.allow` — the engine source sits OUTSIDE this app's root (../../src and the
//     repo root), so Vite's dev file-serving allowlist must include the repo root or the dev
//     server refuses to read those files.
//
// The pg/mysql drivers are loaded by `compose()` only when DATABASE_URL is set (dynamic
// import), so they stay external and are never pulled into the bundle unless actually used.
export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    // `#src/economy.ts` -> `<repoRoot>/src/economy.ts`. Mirrors the root
    // package.json "imports" map so the engine resolves to the exact same file
    // from inside this app's build/SSR pipeline.
    // `~/ui` -> `<appDir>/ui`. Mirrors the tsconfig "paths" alias so app-local imports resolve at
    // build/SSR time, not just for the type-checker.
    alias: [
      { find: /^#(.*)$/, replacement: `${repoRoot}$1` },
      { find: /^~\/(.*)$/, replacement: `${appDir}$1` },
    ],
  },
  ssr: {
    // Compile the engine's `.ts` source through Vite rather than treating it as an external
    // Node module. A regex keeps every file under the repo `src/` tree in the transform path.
    noExternal: [/economy-lab[\\/]src[\\/]/],
    // The optional DB/cache/queue drivers are dynamically imported by compose() only when their
    // env var is set; keep them external so an unused driver is never bundled or required.
    external: ['pg', 'mysql2', 'ioredis', '@aws-sdk/client-sqs'],
  },
  server: {
    fs: {
      // Allow reading the engine source that lives above this app (the repo root).
      allow: ['..', '../..'],
    },
  },
});
