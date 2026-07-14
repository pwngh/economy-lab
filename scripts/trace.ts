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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { makeEconomy } from '#test/support/economy.ts';
import { topUp, grantPromo, spend, credit } from '#test/support/builders.ts';
import { encodeAmount, isAmount } from '#src/money.ts';
import { spendable, promo, earned, SYSTEM } from '#src/accounts.ts';

import type { Economy, Operation, Outcome } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';

// Golden-trace runner: replays the canonical scenario and renders it to a stable text form.
// NOTE: with no flag this WRITES test/golden/canonical.trace; `--check` (what CI runs, via
// `npm run trace:check`) compares against the golden without writing. `--update` also overwrites.
const SCENARIO = 'canonical';
const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, '..', 'test', 'golden', `${SCENARIO}.trace`);

// --- Stable output shape --------------------------------

// Object keys are sorted and every Amount becomes its decimal string (an Amount wraps a bigint JSON
// cannot print). A bare bigint means an Amount was missed, so this throws rather than converting it.
function canonical(value: unknown): unknown {
  if (isAmount(value)) {
    return encodeAmount(value);
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonical(source[key]);
    }
    return out;
  }
  if (typeof value === 'bigint') {
    throw new Error(
      'a bare bigint reached the trace; encode it as an Amount first',
    );
  }
  return value;
}

// One value per line, so a diff points at the exact changed line.
function render(value: unknown): string {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

// --- The canonical scenario -----------------------------------------------------------

// Stable across runs: the test economy issues ids in a fixed sequence and uses a frozen clock.
function recordStep(kind: string, outcome: Outcome): Record<string, unknown> {
  if (outcome.status === 'rejected') {
    return { kind, status: outcome.status, reason: outcome.reason };
  }
  return {
    kind,
    status: outcome.status,
    transaction: {
      id: outcome.transaction.id,
      postedAt: outcome.transaction.postedAt,
      legs: outcome.transaction.legs.map((leg) => ({
        account: leg.account,
        amount: leg.amount,
      })),
    },
  };
}

async function step(
  economy: Economy,
  steps: Record<string, unknown>[],
  operation: Operation,
): Promise<Outcome> {
  const outcome = await economy.submit(operation);
  steps.push(recordStep(operation.kind, outcome));
  return outcome;
}

async function buildTrace(): Promise<Record<string, unknown>> {
  const economy = makeEconomy();
  const steps: Record<string, unknown>[] = [];

  await step(
    economy,
    steps,
    topUp({ userId: 'usr_buyer', amount: credit('20.00') }),
  );
  await step(
    economy,
    steps,
    grantPromo({ userId: 'usr_buyer', amount: credit('5.00') }),
  );
  const purchase = spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_bundle',
    price: credit('12.00'),
    recipients: [
      { sellerId: 'usr_a', shareBps: 6_000 },
      { sellerId: 'usr_b', shareBps: 4_000 },
    ],
  });
  await step(economy, steps, purchase);
  await step(economy, steps, purchase); // the same purchase again, which must stay idempotent and not charge twice
  await step(
    economy,
    steps,
    spend({ buyerId: 'usr_buyer', sku: 'wrld_pass', price: credit('999.00') }),
  );

  return {
    scenario: SCENARIO,
    steps,
    prove: await economy.read.prove(),
    balances: await keyBalances(economy),
  };
}

async function keyBalances(economy: Economy): Promise<Record<string, unknown>> {
  const accounts: ReadonlyArray<readonly [string, AccountRef]> = [
    ['buyer.spendable', spendable('usr_buyer')],
    ['buyer.promo', promo('usr_buyer')],
    ['seller.a.earned', earned('usr_a')],
    ['seller.b.earned', earned('usr_b')],
    ['revenue', SYSTEM.REVENUE],
    ['promo_float', SYSTEM.PROMO_FLOAT],
    ['trust_cash', SYSTEM.TRUST_CASH],
    ['usd_clearing', SYSTEM.USD_CLEARING],
  ];
  const out: Record<string, unknown> = {};
  for (const [label, account] of accounts) {
    out[label] = await economy.read.balance(account);
  }
  return out;
}

// --- Comparing against (or rewriting) the golden -------------------
//
// The golden file is the checked-in expected trace.

async function readGolden(): Promise<string | null> {
  try {
    return await readFile(GOLDEN, 'utf8');
  } catch {
    return null;
  }
}

async function writeGolden(content: string): Promise<void> {
  await mkdir(dirname(GOLDEN), { recursive: true });
  await writeFile(GOLDEN, content, 'utf8');
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--check')
    ? 'check'
    : process.argv.includes('--update')
      ? 'update'
      : 'emit';
  const content = render(await buildTrace());

  if (mode === 'update' || mode === 'emit') {
    const existed = (await readGolden()) !== null;
    await writeGolden(content);
    console.warn(`trace: ${existed ? 'rewrote' : 'wrote'} ${GOLDEN}`);
    return;
  }

  const golden = await readGolden();
  if (golden === null) {
    console.error(
      `trace: no golden at ${GOLDEN}; run "npm run trace -- --update" first.`,
    );
    process.exitCode = 1;
    return;
  }
  if (golden !== content) {
    console.error(`trace: drift against ${GOLDEN} — byte-diff below.`);
    console.error(firstDiff(golden, content));
    process.exitCode = 1;
    return;
  }
  console.warn('trace: byte-clean against the golden.');
}

function firstDiff(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}:\n  golden: ${a[i] ?? '<none>'}\n  actual: ${b[i] ?? '<none>'}`;
    }
  }
  return '(no line difference — trailing bytes differ)';
}

await main();
