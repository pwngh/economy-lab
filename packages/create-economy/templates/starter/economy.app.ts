/**
 * economy.app.ts — the whole app: one file, named exports only, everything optional except
 * the posture. `economy check` prints what this compiles to.
 */

import { bearerStack, devTokens } from '@pwngh/economy/auth';
import { credits } from '@pwngh/economy/money';
import type { EconomyModule } from '@pwngh/economy/module';

// Prices live in your listings store, never in a frozen catalog. Every sale names who earned
// it, so a first-party storefront names its own account: one recipient at the whole 10,000
// basis points. The marketplace template splits that between real sellers.
const STORE = 'usr_studio';

const listings = new Map([
  [
    'starter-pack',
    {
      price: credits(120),
      recipients: [{ sellerId: STORE, shareBps: 10_000 }],
    },
  ],
  [
    'world-kit',
    {
      price: credits(2_500),
      recipients: [{ sellerId: STORE, shareBps: 10_000 }],
    },
  ],
]);

// Headroom past the 1,000-credit/hour dev velocity cap, so the world-kit sale goes through.
export const policy = { velocityLimitMinor: 10_000_000n };

// The two catalog halves: bundles is the top-up menu (600, 1,200, and 6,000 credits — the
// $5, $10, and $50 packs at 120 credits to the dollar), and a top-up off that menu is
// refused. lookup gives submit the exact price a spend must carry, so a client that names
// its own price answers CATALOG_MISMATCH before the ledger sees it.
export const catalog = {
  bundles: [60_000n, 120_000n, 600_000n],
  lookup: (sku: string) => listings.get(sku) ?? null,
};

// Your production resolver goes first; the loopback-gated dev tail answers `dev_user_ada`
// and friends while you build.
export const authenticate = bearerStack(
  // authJwks('https://id.example.com/.well-known/jwks.json'),
  devTokens.loopbackOnly(),
);

// The checkout: the client names a sku and its order id. Price and split come from the
// catalog, and the framework stamps the authenticated buyer onto the returned draft.
export const routes = {
  'POST /checkout': async ({ request }: { request: Request }) => {
    const { sku, orderId } = (await request.json()) as {
      sku: string;
      orderId: string;
    };
    const offer = listings.get(sku);
    if (!offer) return new Response(null, { status: 404 });
    return { kind: 'spend' as const, orderId, sku, ...offer };
  },
};

// Background sweeps: maturity, the outbox relay, retention. Every five seconds in dev.
export const worker = { intervalMs: 5_000 };

// The seams this app leaves at their defaults, with their one-line forms:
//   export const providers = { pay: (raw) => … };   — decode a provider webhook
//   export const after = { 'economy.sale.completed': (e) => … };  — post-commit handlers
//   export const ports = { store: await postgres(…) };  — the store production requires
//   export const flags = { payouts: false };        — the closed economy
({ policy, catalog, authenticate, routes, worker }) satisfies EconomyModule;
