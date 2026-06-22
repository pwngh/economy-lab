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

let SCENARIO = 'phase1';
let HERE = dirname(fileURLToPath(import.meta.url));
let GOLDEN = join(HERE, '..', 'test', 'golden', `${SCENARIO}.trace`);

// --- Turning a value into a stable shape for output --------------------------------

// Rewrites a value so it serializes to the exact same bytes on every machine and run:
// object keys are sorted into a fixed order, and every money Amount is turned into its
// decimal-string form via encodeAmount (an Amount holds a bigint, which JSON can't print
// directly). A bare bigint that reaches here means some Amount was missed and would have
// serialized wrong, so we throw instead of quietly converting it to a string.
function canonical(value: unknown): unknown {
  if (isAmount(value)) {
    return encodeAmount(value);
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    let source = value as Record<string, unknown>;
    let out: Record<string, unknown> = {};
    for (let key of Object.keys(source).sort()) {
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

// Turns a value into the final text written to (or compared against) the saved reference
// output (the "golden" file, a checked-in copy of the expected trace): pretty-printed JSON
// with a two-space indent and a trailing newline, so the output is readable and a diff can
// point at the exact line that changed.
function render(value: unknown): string {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

// --- The fixed scenario -----------------------------------------------------------

// Turns the result of one submitted operation into the plain object recorded in the trace.
// A rejected operation records only why it was declined; a successful one records the
// transaction's id, its post time, and each money line (account plus amount). The output is
// the same on every run because the test economy hands out ids in a fixed sequence and uses
// a frozen clock, so id and post time never vary.
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

// Submits one operation, appends a record of what happened to the running list of steps,
// and returns the result. Keeping every step in one flat list means the trace reads
// top-to-bottom in the same order the operations ran.
async function step(
  economy: Economy,
  steps: Record<string, unknown>[],
  operation: Operation,
): Promise<Outcome> {
  let outcome = await economy.submit(operation);
  steps.push(recordStep(operation.kind, outcome));
  return outcome;
}

// Runs the whole fixed scenario against a fresh test economy and returns everything that
// goes into the trace: the ordered list of steps, the integrity report from prove() (which
// checks money was conserved and that real cash still covers what users are owed), and a
// pinned set of key account balances. Recording all three means any change in the money
// lines, the integrity checks, or a balance shows up as a difference in the output.
//
// The scenario walks through: a top-up, a promo grant, a purchase split between two sellers,
// the exact same purchase submitted again to confirm it isn't charged twice, and an
// over-priced purchase that should be declined for insufficient funds.
async function buildTrace(): Promise<Record<string, unknown>> {
  let economy = makeEconomy();
  let steps: Record<string, unknown>[] = [];

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
  let purchase = spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_bundle',
    price: credit('12.00'),
    recipients: [
      { sellerId: 'usr_a', shareBps: 6_000 },
      { sellerId: 'usr_b', shareBps: 4_000 },
    ],
  });
  await step(economy, steps, purchase);
  await step(economy, steps, purchase); // submit the same purchase again; it must not charge twice
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

// Reads the balance of a hand-picked set of accounts under stable labels: the buyer's
// spendable and promo balances, each seller's earnings, and the platform's own accounts.
// Recording these means a bug in how a purchase is split, how promo credit is drawn down,
// or how cash is tracked will change one of these numbers and show up in the trace.
async function keyBalances(economy: Economy): Promise<Record<string, unknown>> {
  let accounts: ReadonlyArray<readonly [string, AccountRef]> = [
    ['buyer.spendable', spendable('usr_buyer')],
    ['buyer.promo', promo('usr_buyer')],
    ['seller.a.earned', earned('usr_a')],
    ['seller.b.earned', earned('usr_b')],
    ['revenue', SYSTEM.REVENUE],
    ['promo_float', SYSTEM.PROMO_FLOAT],
    ['trust_cash', SYSTEM.TRUST_CASH],
    ['usd_clearing', SYSTEM.USD_CLEARING],
  ];
  let out: Record<string, unknown> = {};
  for (let [label, account] of accounts) {
    out[label] = await economy.read.balance(account);
  }
  return out;
}

// --- Comparing against (or rewriting) the saved reference output -------------------
//
// The "golden" file is a saved copy of the expected trace, checked into the repo. A run
// either compares fresh output against it (to catch unintended changes) or overwrites it
// (to accept an intended change).

// Reads the saved golden file, or returns null if it doesn't exist yet.
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

// Entry point. Picks a mode from the command-line flags: `--check` compares fresh output
// against the saved golden and fails (sets a non-zero exit code) if they differ, `--update`
// overwrites the golden with the fresh output, and with no flag it just writes the file.
// The `--check` mode is what CI runs to catch unintended changes to the trace.
async function main(): Promise<void> {
  let mode = process.argv.includes('--check')
    ? 'check'
    : process.argv.includes('--update')
      ? 'update'
      : 'emit';
  let content = render(await buildTrace());

  if (mode === 'update' || mode === 'emit') {
    let existed = (await readGolden()) !== null;
    await writeGolden(content);
    console.warn(`trace: ${existed ? 'rewrote' : 'wrote'} ${GOLDEN}`);
    return;
  }

  let golden = await readGolden();
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

// Finds the first line where the saved golden and the fresh output differ, and reports just
// that line from each side. This points the failure report straight at the change instead of
// printing the entire document.
function firstDiff(expected: string, actual: string): string {
  let a = expected.split('\n');
  let b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}:\n  golden: ${a[i] ?? '<none>'}\n  actual: ${b[i] ?? '<none>'}`;
    }
  }
  return '(no line difference — trailing bytes differ)';
}

await main();
