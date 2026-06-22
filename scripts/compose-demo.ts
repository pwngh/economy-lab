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

// Runnable demo of `compose` in src/index.ts, the function that wires up the economy from
// environment variables. This script reads the same environment a real deployment would, prints
// which backend each env var picked (the database, the optional cache, and where outgoing events
// are sent), runs a small money flow through the wired-up economy, then reads the balances back
// out of whichever backend was selected. Change the env vars to switch backends:
//
//   node scripts/compose-demo.ts                                              # memory
//   DATABASE_URL=postgres://economy:economy@localhost:5432/economy_lab  ...    # postgres
//   DATABASE_URL=mysql://root:economy@localhost:3306/economy_lab        ...    # mysql
//   REDIS_URL=redis://localhost:6379 ...                                       # + cache in front of reads
//
// On the in-memory backend the script is self-contained. For a SQL backend it uses the schema
// already there (run `npm run db:migrate` first); set DEMO_RESET=1 to drop & recreate it for a
// clean run, which DESTROYS all data — a demo convenience a real deployment never does (issue #20).

import { readFile } from 'node:fs/promises';

import { compose } from '#src/index.ts';
import { topUp, spend, requestPayout, credit } from '#test/support/builders.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';
import {
  defaultPricing,
  seededSigner,
  fakeProcessor,
  fixedRates,
} from '#test/support/capabilities.ts';

import type { Amount } from '#src/money.ts';

// The few methods of the `pg` (PostgreSQL driver) package this demo's schema reset calls. The
// driver ships no TypeScript types, so we declare just the parts we use here.
interface PgDemoClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
interface PgDemoModule {
  Client: new (config: { connectionString: string }) => PgDemoClient;
}

// Work out which backend each env var would pick, and return a human-readable label for each.
// This repeats the choices compose() makes internally, only so the demo can print them; compose()
// itself returns just the wired-up economy, not these labels.
function selection(env: Record<string, string | undefined>): {
  store: string;
  cache: string;
  dispatcher: string;
} {
  const db = env.DATABASE_URL ?? '';
  const store =
    db === ''
      ? 'memory (no DATABASE_URL)'
      : db.startsWith('postgres')
        ? `postgres (${db})`
        : db.startsWith('mysql')
          ? `mysql (${db})`
          : `?? unsupported scheme: ${db.split(':')[0]}`;
  const cache = env.REDIS_URL
    ? `redis (${env.REDIS_URL})`
    : 'none (reads hit the store)';
  const dispatcher = env.SQS_QUEUE_URL
    ? `sqs (${env.SQS_QUEUE_URL})`
    : env.DISPATCHER_URL
      ? `http (${env.DISPATCHER_URL})`
      : 'in-process (default)';
  return { store, cache, dispatcher };
}

// For a SQL backend, optionally reset the database to a clean schema. This is a DESTRUCTIVE
// drop-and-recreate, so it runs only when DEMO_RESET=1 is set; otherwise the demo uses whatever
// schema is already there (run `npm run db:migrate` first). Does nothing for the in-memory backend.
async function ensureSchema(
  env: Record<string, string | undefined>,
): Promise<void> {
  const url = env.DATABASE_URL ?? '';
  const isSql = url.startsWith('postgres') || url.startsWith('mysql');
  if (!isSql) {
    return;
  }
  if (env.DEMO_RESET !== '1') {
    console.warn(
      'demo: DATABASE_URL is set but DEMO_RESET!=1 — using the EXISTING schema (run `npm run\n' +
        '      db:migrate` first). Set DEMO_RESET=1 to drop & recreate it, which DESTROYS all data.',
    );
    return;
  }
  console.warn(
    'demo: DEMO_RESET=1 — dropping and recreating the schema (DESTROYS all data).',
  );
  if (url.startsWith('postgres')) {
    // pg ships no type declarations; the binding is typed via PgDemoModule.
    // @ts-expect-error -- untyped dynamic import, typed at the binding.
    const pg: PgDemoModule = (await import('pg')).default;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('drop schema public cascade; create schema public;');
    const sql = await readFile(
      new URL('../db/postgresql-schema.sql', import.meta.url),
      'utf8',
    );
    await client.query(sql);
    await client.end();
  } else if (url.startsWith('mysql')) {
    const { createMysqlPool, applyMysqlSchema } =
      await import('#src/adapters/mysql.ts');
    const pool = await createMysqlPool(url);
    await applyMysqlSchema(pool);
    await (pool as { end?: () => Promise<void> }).end?.();
  }
}

// Format an Amount for display. Amounts store value as an integer count of minor units (cents),
// so divide by 100 to get whole currency units, e.g. { currency: 'USD', minor: 5000n } -> "USD 50.00".
function fmt(a: Amount): string {
  return `${a.currency} ${(Number(a.minor) / 100).toFixed(2)}`;
}

const env = {
  WEBHOOK_SECRET: 'demo-webhook-secret',
  SIGNING_SECRET: 'demo-signing-secret',
  // Demo-only policy so the whole flow runs in one shot. A deployment sets these from real policy:
  //   - 0-ms maturity so a just-topped-up balance is immediately spendable and earnings are
  //     immediately payable (real default: a 7-day card chargeback window, so funds are held).
  //   - a tiny payout minimum so the demo's modest earnings clear the gate (real default: 20,000).
  MATURITY_HORIZON_CARD_MS: '0',
  MATURITY_HORIZON_DEFAULT_MS: '0',
  PAYOUT_MIN_EARNED_MINOR: '100',
  ...process.env,
};

const sel = selection(env);
console.warn('=== compose() adapter selection ===');
console.warn(`Store:      ${sel.store}`);
console.warn(`Cache:      ${sel.cache}`);
console.warn(`Dispatcher: ${sel.dispatcher}`);

await ensureSchema(env);

const economy = await compose(env, {
  pricing: defaultPricing(),
  signer: seededSigner(1),
  processor: fakeProcessor(),
  rates: fixedRates(),
});

// Fresh ids per run so the printed balances are clean regardless of accumulated DB state.
const tag = Math.random().toString(36).slice(2, 8);
const buyer = `usr_buyer_${tag}`;
const creatorA = `usr_creator_a_${tag}`;
const creatorB = `usr_creator_b_${tag}`;
const bundle = `prod_${tag}`;

console.warn(
  '\n--- flow: top up, buy from two creators, request a payout, prove ---',
);

// 1. The platform credits the buyer's wallet after a card charge clears (a trusted service does
//    this, not the user).
const r1 = await economy.submit(
  topUp({ userId: buyer, amount: credit('50.00'), source: 'card' }),
);
console.warn(`topUp 50.00 → buyer:            ${r1.status}`);

// 2. The buyer spends 12.00 on a listing; the price splits 60/40 between two creators and the
//    platform keeps its fee.
const r2 = await economy.submit(
  spend({
    buyerId: buyer,
    sku: bundle,
    price: credit('12.00'),
    recipients: [
      { sellerId: creatorA, shareBps: 6_000 },
      { sellerId: creatorB, shareBps: 4_000 },
    ],
  }),
);
console.warn(`spend 12.00 (60/40 split):      ${r2.status}`);

// 3. A creator requests a payout. This sets aside the credits the creator earned and starts a
//    multi-step payout workflow that a background worker finishes later. The request must clear a
//    minimum amount and the earnings must be old enough to pay out (a hold period after the sale,
//    in case the buyer's card charge is later reversed), so on brand-new earnings it can come back
//    'rejected' — the accounts still add up to zero either way.
const r3 = await economy.submit(
  requestPayout({ userId: creatorA, amount: credit('5.00') }),
);
console.warn(
  `requestPayout 5.00 ← creatorA:  ${r3.status}` +
    (r3.status === 'rejected' ? ` (${r3.reason})` : ''),
);

console.warn('\n--- balances (read back from the selected store) ---');
console.warn(
  `buyer:spendable     = ${fmt(await economy.read.balance(spendable(buyer)))}`,
);
console.warn(
  `creatorA:earned     = ${fmt(await economy.read.balance(earned(creatorA)))}`,
);
console.warn(
  `creatorB:earned     = ${fmt(await economy.read.balance(earned(creatorB)))}`,
);
console.warn(
  `REVENUE (platform)  = ${fmt(await economy.read.balance(SYSTEM.REVENUE))}`,
);

// 4. Whatever happened above, the ledger still checks out on every rule: debits equal credits,
//    every credit a user can spend is covered by real USD held against it, no user wallet went
//    negative, the per-account chain of hashes (each entry hashes in the one before it) is
//    unbroken, and each account's cached running balance matches the sum of its debit and credit
//    lines.
const report = await economy.read.prove();
console.warn(
  `\nprove(): conserved=${report.conserved} backed=${report.backed} ` +
    `noOverdraft=${report.noOverdraft} chainIntact=${report.chainIntact} ` +
    `consistent=${report.consistent}`,
);

// The postgres/mysql connection pools stay open in the background, which would keep Node.js
// running forever. compose() created and holds those connections, so this script has no handle
// to close them. Since this is a run-once demo, exit the process explicitly once the flow is done.
// eslint-disable-next-line n/no-process-exit
process.exit(0);
