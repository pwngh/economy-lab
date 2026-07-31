/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { bearerStack, devTokens } from '@pwngh/economy-auth';
import { credits } from '@pwngh/economy-money';
import type { EconomyModule } from '@pwngh/economy-core';

// Prices live in your listings store, never in a frozen catalog.
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
]);

// Headroom past the 1,000-credit/hour dev velocity cap: the world-kit sale needs it.
export const policy = { velocityLimitMinor: 10_000_000n };

// The two catalog halves: bundles is the top-up menu (600 and 1,200 credits); lookup
// gives submit the exact price and split a spend must carry — anything else answers
// CATALOG_MISMATCH before the ledger ever sees it.
export const catalog = {
  bundles: [60_000n, 120_000n],
  lookup: (sku: string) => listings.get(sku) ?? null,
};

// Production resolver first, the loopback-gated dev tail last.
export const authenticate = bearerStack(
  // authJwks('https://id.example.com/.well-known/jwks.json'),
  devTokens.loopbackOnly(),
);

// Money in, and payout confirmations back, arrive as verified webhook events — one
// decoder from the provider's payload to the lab's event shape.
export const providers = {
  pay: (raw: unknown) => {
    const r = raw as Record<string, unknown>;
    if (r.kind === 'payoutSettled') {
      return {
        provider: 'pay',
        eventId: String(r.id),
        kind: 'payoutSettled' as const,
        sagaId: String(r.sagaId),
        providerRef: String(r.ref),
      };
    }
    const p = raw as { id: string; user: string; credits: number };
    return {
      provider: 'pay',
      eventId: p.id,
      userId: p.user,
      amount: credits(p.credits),
      source: 'card',
    };
  },
};

// The checkout: the client names a sku and its order id; price and split come from the
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

// Post-commit, at-least-once, through the outbox relay — never load-bearing for the money.
export const after = {
  'economy.sale.completed': (event: { subject: string }) => {
    console.log(`sale completed for ${event.subject}`);
  },
};

// The in-world fast lane; presence mounts POST /instances/:scope/purchase.
export const instances = {};

export const worker = { intervalMs: 5_000 };

// The two seams this app leaves at their defaults, with their one-line forms:
//   export const ports = { logger };            — swap one port, keep the rest
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
