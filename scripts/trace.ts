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

// Golden-trace runner: replays the fixed phase-1 scenario and renders it to a stable text form.
// NOTE: with no flag this WRITES test/golden/phase1.trace; `--check` (what CI runs, via
// `npm run trace:check`) compares against the golden without writing. `--update` also overwrites.
const SCENARIO = 'phase1';
const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, '..', 'test', 'golden', `${SCENARIO}.trace`);

// --- Stable output shape --------------------------------

// Rewrites a value so it serializes to identical bytes on every machine and run. Object keys are
// sorted, and every Amount becomes its decimal string via encodeAmount because an Amount wraps a
// bigint that JSON cannot print. A bare bigint here means an Amount was missed and would serialize
// wrong, so this throws rather than silently converting it.
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

// Renders the final golden text as pretty-printed JSON with a two-space indent and a trailing
// newline. The one-value-per-line layout makes a diff point at the exact changed line.
function render(value: unknown): string {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

// --- The fixed scenario -----------------------------------------------------------

// Turns one operation's outcome into a plain trace record. A rejected outcome records only its
// reason. A successful one records the transaction id, the post time, and each leg's account and
// amount. The record is stable across runs because the test economy issues ids in a fixed sequence
// and uses a frozen clock.
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

// Submits one operation, appends its record to steps, and returns the outcome. The single flat
// list keeps the trace in operation order.
async function step(
  economy: Economy,
  steps: Record<string, unknown>[],
  operation: Operation,
): Promise<Outcome> {
  const outcome = await economy.submit(operation);
  steps.push(recordStep(operation.kind, outcome));
  return outcome;
}

// Runs the scenario against a fresh test economy and returns the trace contents: the ordered
// steps, the prove() integrity report, and a pinned set of key balances. Any change to the system
// shows up in the diff against the golden.
//
// The scenario runs five operations in order. It tops up the buyer, grants a promo, and makes a
// purchase split between two sellers. It then submits that same purchase again, which must not
// charge twice. It ends with an over-priced purchase that is declined for insufficient funds.
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

// Reads the balances of a hand-picked set of accounts under stable labels. The set covers the
// buyer's spendable and promo accounts, each seller's earnings, and the platform accounts.
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
// The golden file is the checked-in expected trace. A run either compares fresh output against it
// to catch unintended changes, or overwrites it to accept an intended change.

// Reads the golden file, returning null if it does not exist yet.
async function readGolden(): Promise<string | null> {
  try {
    return await readFile(GOLDEN, 'utf8');
  } catch {
    return null;
  }
}

// Writes the golden file, creating its directory first if needed.
async function writeGolden(content: string): Promise<void> {
  await mkdir(dirname(GOLDEN), { recursive: true });
  await writeFile(GOLDEN, content, 'utf8');
}

// Entry point. The mode comes from the flags. `--check` compares fresh output against the golden
// and exits non-zero on any difference, which is what CI runs. `--update` overwrites the golden.
// No flag just writes the file.
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

// Finds the first line where the golden and the fresh output differ. It reports just that one line
// from each side instead of the whole document.
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
