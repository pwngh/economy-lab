import type { Config } from '@react-router/dev/config';

// Server-side rendering on: this app runs the REAL economy-lab engine on the server
// ("remote mode"). Loaders read live engine state, actions mutate it, and the rendered
// HTML reflects the in-memory (or DB-backed) ledger — never a client-side stub.
export default {
  ssr: true,
} satisfies Config;
