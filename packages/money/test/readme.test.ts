/**
 * @pwngh/economy-money
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Bps, Money, Rate, bps } from '../src/index.js';

const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  name: string;
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
};

/** The umbrella door a README import names, and the module in this package behind it. */
const DOORS: Record<string, string> = {
  '@pwngh/economy/money': '../src/index.js',
  '@pwngh/economy/money/rate': '../src/lib/rate.js',
  '@pwngh/economy/money/bps': '../src/lib/bps.js',
  '@pwngh/economy/money/wire-value': '../src/lib/wire-value.js',
};

test('the README is the house shape, and its roster is the whole root door', async () => {
  // Derived, so a rename moves the pin with it.
  assert.equal(
    md.startsWith(`# ${pkg.name.replace('@pwngh/economy-', '')}\n`),
    true,
  );

  const root = (await import('../src/index.js')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(root).sort(), [
    'Bps',
    'Money',
    'Rate',
    'bps',
    'createBps',
    'createMoney',
    'createRate',
    'credits',
    'usd',
  ]);
  for (const name of Object.keys(root)) {
    assert.match(md, new RegExp(`\\b${name}\\b`), `README covers ${name}`);
  }
});

// The README teaches subpaths, and a subpath the umbrella does not carry is a paste that fails
// in the reader's editor. Every one it names is a door onto a module in this package.
test('every import the README shows is a door onto an export this package has', async () => {
  let checked = 0;
  for (const m of md.matchAll(
    /import\s+\{([^}]+)\}\s+from\s+'(@pwngh\/economy\/money[^']*)'/g,
  )) {
    const spec = m[2]!;
    const behind = DOORS[spec];
    assert.ok(
      behind,
      `README imports from ${spec}, which is not one of this package's doors`,
    );
    const names = new Set(Object.keys((await import(behind!)) as object));
    for (const raw of m[1]!.split(',')) {
      const named = raw.trim();
      if (!named) continue;
      assert.ok(names.has(named), `${spec} does not export ${named}`);
      checked += 1;
    }
  }
  // Seven import lines carry the money doors; a regex that stopped matching would pass in silence.
  assert.equal(checked, 15, `checked ${checked} imported names`);

  // And each door is an export of this package, spelled the way the manifest maps it.
  for (const spec of Object.keys(DOORS)) {
    const sub = spec.slice('@pwngh/economy/money'.length);
    assert.ok(
      (sub === '' ? '.' : `.${sub}`) in pkg.exports,
      `${spec} is a door onto a subpath this package does not export`,
    );
  }
});

// Every printed value here is real output. A rounding change anywhere below this package would
// leave the README saying the old number.
test('the values the README prints are the ones the code produces', () => {
  const payout = Rate.from({
    rate: '5',
    scale: 3,
    rateId: 'payout:CREDIT->USD:5/3',
  });
  const raw = Rate.from({ rate: '5', scale: 0, rateId: 'raw:CREDIT->USD:5/0' });
  const price = Money.from('CREDIT:999.99');
  const split = [bps(3_333), bps(3_333), bps(3_334)];
  const big = Money.from({ currency: 'CREDIT', minor: 9_007_199_254_740_993n });

  const printed: [string, string][] = [
    ['minor', `${Money.from('CREDIT:600.00').minor}`],
    ['the rate wire form', payout.toString()],
    [
      'the payout minimum',
      payout.convertFloor('CREDIT:20000.00', 'USD').toString(),
    ],
    ['the floor', payout.convertFloor('CREDIT:20001.00', 'USD').toString()],
    ['the ceil', payout.convertCeil('CREDIT:20001.00', 'USD').toString()],
    // What the same multiplier is worth at scale 0, which is what a dropped scale used to read as.
    [
      'the multiplier raw',
      raw.convertFloor('CREDIT:20000.00', 'USD').toString(),
    ],
    ['a share', bps(3_333).share('CREDIT:999.99').toString()],
    [
      'the fee to the whole credit',
      bps(1_530).fee('CREDIT:1000.50').toString(),
    ],
    [
      'revenue over an uneven split',
      bps(1_530).revenue(price, split).toString(),
    ],
    ['the whole', `${Bps.WHOLE}`],
    ['the integer no double names', big.toString()],
    ['what a float would have made of it', `${Number(big.decimal)}`],
  ];

  for (const [what, value] of printed) {
    assert.ok(
      md.includes(value),
      `the README prints ${what} as something other than ${value}`,
    );
  }
  assert.equal(printed.length, 12);
});

test('the errors the README quotes are the ones that throw', () => {
  const thrown: [() => unknown, string][] = [
    [() => Money.from('EUR:1.00'), 'MONEY.INVALID_AMOUNT'],
    [() => Rate.from(null as never), 'CONFIG.INVALID'],
    // The wire door, because an init object short a field no longer compiles.
    [
      () => Rate.from('{"rate":"5","rateId":"payout:CREDIT->USD:5/3"}'),
      'CONFIG.INVALID',
    ],
    [() => Bps.from(10_001), 'OP.MALFORMED'],
  ];

  for (const [call, code] of thrown) {
    let caught: { code?: string; message?: string } | undefined;
    assert.throws(call, (error: unknown) => {
      caught = error as { code?: string; message?: string };
      return true;
    });
    assert.equal(caught!.code, code);
    assert.ok(
      md.includes(`${code}: ${caught!.message}`),
      `the README quotes ${code} as something other than "${caught!.message}"`,
    );
  }
  assert.equal(thrown.length, 4);
});

// "Every computation runs in @pwngh/economy-lab" is a claim about the dependency list as much as
// about the code, so both are read.
test('the delegation the README claims is the dependency it has', async () => {
  assert.deepEqual(Object.keys(pkg.dependencies), ['@pwngh/economy-lab']);
  const lab = (await import('@pwngh/economy-lab')) as Record<string, unknown>;
  const delegated = [
    'toAmount',
    'decodeAmountWire',
    'encodeAmount',
    'add',
    'negate',
    'compare',
    'isZero',
    'convertFloor',
    'convertCeil',
    'feeForPrice',
    'revenueForSplit',
    'rateGte',
  ];
  for (const name of delegated) {
    assert.ok(
      md.includes(`\`${name}\``),
      `the README lists ${name} as the lab's`,
    );
    assert.equal(typeof lab[name], 'function', `the lab still exports ${name}`);
  }
  assert.equal(delegated.length, 12);
});
