/**
 * economy.app.ts — the whole app: one file, named exports only, everything optional except
 * the posture. `economy check` prints what this compiles to.
 */

import { bearerStack, devTokens } from '@pwngh/economy/auth';
import { credits } from '@pwngh/economy/money';
import type { EconomyModule } from '@pwngh/economy/module';

// Prices and splits live in your listings store, never in a frozen catalog. Shares are basis
// points and must sum to 10,000; whatever rounding leaves over goes to platform revenue.
const listings = new Map([
  [
    'starter-pack',
    {
      price: credits(120),
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    },
  ],
  [
    'world-kit',
    {
      price: credits(25_000),
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    },
  ],
  [
    'collab-kit',
    {
      price: credits(30_000),
      recipients: [
        { sellerId: 'usr_ben', shareBps: 7_000 },
        { sellerId: 'usr_cal', shareBps: 3_000 },
      ],
    },
  ],
]);

// Headroom past the 1,000-credit/hour dev velocity cap: these are payout-scale amounts.
export const policy = { velocityLimitMinor: 10_000_000n };

// The two catalog halves: bundles is the top-up menu (600, 1,200, 6,000, and 30,000 credits
// — the $5, $10, $50, and $250 packs at 120 credits to the dollar), and a top-up off that
// menu is refused. lookup gives submit the exact price and split a spend must carry, so a
// client that names its own answers CATALOG_MISMATCH before the ledger sees it.
export const catalog = {
  bundles: [60_000n, 120_000n, 600_000n, 3_000_000n],
  lookup: (sku: string) => listings.get(sku) ?? null,
};

// Your production resolver goes first; the loopback-gated dev tail answers `dev_user_ada`
// and friends while you build.
export const authenticate = bearerStack(
  // authJwks('https://id.example.com/.well-known/jwks.json'),
  devTokens.loopbackOnly(),
);

// Money in, and payout confirmations back, arrive as verified webhook events — one decoder
// from the provider's payload to the ledger's event shape. Presence mounts
// POST /webhooks/pay; a verified event lands in the inbox for the next sweep.
export const providers = {
  pay: (raw: unknown) => {
    const event = raw as Record<string, unknown>;
    if (event.kind === 'payoutSettled') {
      return {
        provider: 'pay',
        eventId: String(event.id),
        kind: 'payoutSettled' as const,
        sagaId: String(event.sagaId),
        providerRef: String(event.ref),
      };
    }
    const paid = raw as { id: string; user: string; credits: number };
    return {
      provider: 'pay',
      eventId: paid.id,
      userId: paid.user,
      amount: credits(paid.credits),
      source: 'card',
    };
  },
};

export const routes = {
  // The checkout: the client names a sku and its order id. Price, split, and buyer all come
  // from the catalog and the authenticated principal, so none of them can be forged.
  'POST /checkout': async ({ request }: { request: Request }) => {
    const { sku, orderId } = (await request.json()) as {
      sku: string;
      orderId: string;
    };
    const offer = listings.get(sku);
    if (!offer) return new Response(null, { status: 404 });
    return { kind: 'spend' as const, orderId, sku, ...offer };
  },

  // Cashing out: a seller asks for their own earned credits, and the framework stamps the
  // authenticated user as the subject. The ledger checks the minimum, the maturity horizon,
  // and the daily cooldown, then opens a payout saga against the rail.
  'POST /payouts': async ({ request }: { request: Request }) => {
    const { amount } = (await request.json()) as { amount: number };
    return { kind: 'requestPayout' as const, amount: credits(amount) };
  },
};

// Post-commit, at-least-once, through the outbox relay — never load-bearing for the money.
export const after = {
  'economy.sale.completed': (event: { subject: string }) => {
    console.log(`sale completed for ${event.subject}`);
  },
  'economy.payout.settled': (event: { subject: string }) => {
    console.log(`payout settled for ${event.subject}`);
  },
};

// The in-world fast lane; presence mounts POST /instances/:scope/purchase.
export const instances = {};

// Background sweeps: maturity, the payout saga poller, the outbox relay, retention.
export const worker = { intervalMs: 5_000 };

// The seams this app leaves at their defaults, with their one-line forms:
//   export const ports = { store: await postgres(…) };  — the store production requires
//   export const flags = { payouts: false };    — the closed economy
({
  policy,
  catalog,
  authenticate,
  providers,
  routes,
  after,
  instances,
  worker,
}) satisfies EconomyModule;
