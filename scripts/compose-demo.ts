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

/**
 * Runnable demo of `openPorts` (src/index.ts), which wires up the economy from env vars. Reads the
 * same env a real deployment would, prints which backend each var picked (db, optional cache, event
 * dispatcher), runs a small money flow, then reads balances back from the selected backend. Switch
 * backends via env:
 *
 *   node scripts/compose-demo.ts                                              # memory
 *   DATABASE_URL=postgres://economy:economy@localhost:5432/economy_lab  ...    # postgres
 *   DATABASE_URL=mysql://root:economy@localhost:3306/economy_lab        ...    # mysql
 *   REDIS_URL=redis://localhost:6379 ...                                       # + cache in front of reads
 *
 * The in-memory backend is self-contained. SQL backends use the existing schema, so run
 * `make db-migrate` first. Setting DEMO_RESET=1 drops and recreates that schema, which DESTROYS all
 * data. It is a demo convenience.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/the-economy/ The Economy} for the
 * money flow this sample walks through.
 */

import { readFile } from 'node:fs/promises';

import { createEconomy, describeEnv, openPorts } from '#src/index.ts';
import { loadPg } from '#src/engines/pg-driver.ts';
import { isMysqlUrl, isPostgresUrl, readFlag, readUrl } from '#src/env.ts';
import { topUp, spend, requestPayout, credit } from '#test/support/builders.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';
import {
  defaultPricing,
  seededSigner,
  fakeProcessor,
  fixedRates,
} from '#test/support/capabilities.ts';
import { maskUrl } from '#scripts/support/harness.ts';

import type { EnvMap } from '#src/env.ts';
import type { Amount } from '#src/money.ts';

// Builds human-readable labels for the backends the env picks, from describeEnv — the very
// reading openPorts() wires from — so a printed label can never diverge from the actual selection.
function selection(env: EnvMap): {
  store: string;
  cache: string;
  dispatcher: string;
} {
  const picked = describeEnv(env);
  const store =
    picked.store.kind === 'memory'
      ? 'memory (no DATABASE_URL)'
      : picked.store.kind === 'unsupported'
        ? `?? unsupported scheme: ${(picked.store.url ?? '').split(':')[0]}`
        : `${picked.store.kind} (${maskUrl(picked.store.url ?? '')})`;
  const cache =
    picked.cache.kind === 'none'
      ? 'none (reads hit the store)'
      : `redis (${maskUrl(picked.cache.url ?? '')})`;
  const dispatcher =
    picked.dispatcher.kind === 'missing'
      ? 'none (no dispatcher configured)'
      : picked.dispatcher.url === null
        ? picked.dispatcher.kind
        : `${picked.dispatcher.kind} (${picked.dispatcher.url})`;
  return { store, cache, dispatcher };
}

// Optionally resets a SQL database to a clean schema. The reset is a destructive drop-and-recreate
// that runs only when DEMO_RESET=1. Without that flag it uses the existing schema, so run
// `make db-migrate` first. This is a no-op for the in-memory backend.
async function ensureSchema(env: EnvMap): Promise<void> {
  const url = readUrl(env.DATABASE_URL);
  if (url === null || !(isPostgresUrl(url) || isMysqlUrl(url))) {
    return;
  }
  if (!readFlag(env.DEMO_RESET)) {
    console.warn(
      'demo: DATABASE_URL is set but DEMO_RESET!=1 — using the EXISTING schema ' +
        '(run `make db-migrate` first). Set DEMO_RESET=1 to drop & recreate it, which DESTROYS all data.',
    );
    return;
  }
  console.warn(
    'demo: DEMO_RESET=1 — dropping and recreating the schema (DESTROYS all data).',
  );
  if (isPostgresUrl(url)) {
    const pg = await loadPg();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('drop schema public cascade; create schema public;');
    const sql = await readFile(
      new URL('../db/postgresql-schema.sql', import.meta.url),
      'utf8',
    );
    await client.query(sql);
    await client.end();
  } else if (isMysqlUrl(url)) {
    const { createMysqlPool, applyMysqlSchema } =
      await import('#src/engines/mysql.ts');
    const pool = await createMysqlPool(url);
    await applyMysqlSchema(pool);
    await (pool as { end?: () => Promise<void> }).end?.();
  }
}

// Format an Amount for display. Value is an integer count of minor units (cents); divide by 100 for
// whole units, e.g. { currency: 'USD', minor: 5000n } -> "USD 50.00".
function fmt(a: Amount): string {
  return `${a.currency} ${(Number(a.minor) / 100).toFixed(2)}`;
}

const env = {
  WEBHOOK_SECRET: 'demo-webhook-secret',
  SIGNING_SECRET: 'demo-signing-secret',
  // Demo-only policy so the flow clears in one shot. A 0-ms maturity makes funds immediately
  // spendable and payable, and a tiny payout minimum lets the modest earnings clear the gate. A
  // deployment sets these from real policy, such as a 7-day card-chargeback hold and a 20,000 minimum.
  MATURITY_HORIZON_CARD_MS: '0',
  MATURITY_HORIZON_DEFAULT_MS: '0',
  PAYOUT_MIN_EARNED_MINOR: '100',
  ...process.env,
};

const sel = selection(env);
console.warn('=== openPorts() adapter selection ===');
console.warn(`Store:      ${sel.store}`);
console.warn(`Cache:      ${sel.cache}`);
console.warn(`Dispatcher: ${sel.dispatcher}`);

await ensureSchema(env);

const economy = createEconomy(
  await openPorts(env, {
    pricing: defaultPricing(),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
  }),
);

// Fresh ids per run so the printed balances are clean regardless of accumulated DB state.
const tag = Math.random().toString(36).slice(2, 8);
const buyer = `usr_buyer_${tag}`;
const sellerA = `usr_seller_a_${tag}`;
const sellerB = `usr_seller_b_${tag}`;
const bundle = `prod_${tag}`;

console.warn(
  '\n--- flow: top up, buy from two sellers, request a payout, prove ---',
);

// 1. Platform credits the buyer's wallet after a card charge clears (trusted service, not the user).
const r1 = await economy.submit(
  topUp({ userId: buyer, amount: credit('50.00'), source: 'card' }),
);
console.warn(`topUp 50.00 -> buyer:            ${r1.status}`);

// 2. Buyer spends 12.00 on a listing; price splits 60/40 between two sellers, platform keeps its fee.
const r2 = await economy.submit(
  spend({
    buyerId: buyer,
    sku: bundle,
    price: credit('12.00'),
    recipients: [
      { sellerId: sellerA, shareBps: 6_000 },
      { sellerId: sellerB, shareBps: 4_000 },
    ],
  }),
);
console.warn(`spend 12.00 (60/40 split):      ${r2.status}`);

// 3. Seller requests a payout. Brand-new earnings can come back 'rejected', because a minimum and a
//    post-sale hold gate the request. The demo prints whichever status it gets.
const r3 = await economy.submit(
  requestPayout({ userId: sellerA, amount: credit('5.00') }),
);
console.warn(
  `requestPayout 5.00 <- sellerA:  ${r3.status}` +
    (r3.status === 'rejected' ? ` (${r3.detail.reason})` : ''),
);

console.warn('\n--- balances (read back from the selected store) ---');
console.warn(
  `buyer:spendable     = ${fmt(await economy.read.balance(spendable(buyer)))}`,
);
console.warn(
  `sellerA:earned     = ${fmt(await economy.read.balance(earned(sellerA)))}`,
);
console.warn(
  `sellerB:earned     = ${fmt(await economy.read.balance(earned(sellerB)))}`,
);
console.warn(
  `REVENUE (platform)  = ${fmt(await economy.read.balance(SYSTEM.REVENUE))}`,
);

// 4. Regardless of the above, the ledger still holds on every invariant prove() checks.
const report = await economy.read.health();
console.warn(
  `\nprove(): conserved=${report.conserved} backed=${report.backed} ` +
    `noOverdraft=${report.noOverdraft} chainIntact=${report.chainIntact} ` +
    `consistent=${report.consistent}`,
);

// openPorts() holds the postgres/mysql connection pools; this script has no handle to close them,
// and open pools keep Node.js running forever. Run-once demo, so exit explicitly once the flow is done.
// eslint-disable-next-line n/no-process-exit
process.exit(0);
