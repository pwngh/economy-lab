import { fileURLToPath } from 'node:url';

import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

// Repo root, two levels up. The engine is imported via the repo-wide `#*` alias (root
// package.json imports), but `#`-imports are scoped to the nearest package.json — here
// apps/console's, not the root — so Vite wouldn't see the root mapping. Re-map `#<path>` ->
// `<repoRoot>/<path>` below so it resolves to the same engine file.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// This app's source root. The `~/*` -> `./app/*` alias is in tsconfig "paths" (type-checker only);
// Vite needs its own resolver entry below, or `~/x` imports fail at build/SSR time.
const appDir = fileURLToPath(new URL('./app/', import.meta.url));

// The engine at ../../src uses explicit `.ts` specifiers (the no-build convention, so Node's
// --experimental-strip-types runs it directly). Two things are needed for SSR:
//  1. ssr.noExternal — run the engine source through Vite's transform instead of an external
//     require, which Node can't do for a `.ts` file in a bundled context.
//  2. server.fs.allow — the engine sits outside this app's root, so the dev file-serving
//     allowlist must include the repo root.
// The pg/mysql drivers are dynamically imported only when DATABASE_URL is set, so they stay
// external and aren't bundled unless used.
export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    // `#src/...` -> repo root; `~/...` -> this app's app/ dir. Mirror the root imports map and the
    // tsconfig paths alias so both resolve at build/SSR time.
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
