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
import {
  convertFloor,
  encodeAmount,
  feeForPrice,
  revenueForSplit,
  toAmount,
} from '@pwngh/economy-lab';

import { Bps, Money, bps, createBps } from '../src/index.js';

// The same rate shape the ledger divides a share by: bps over 10^4.
const asRate = (count: number) => ({
  rate: BigInt(count),
  scale: 4,
  rateId: `bps:${count}`,
});

test('from() takes a number, a string, and an init object alike', () => {
  for (const value of [1530, '1530', { bps: 1530 }] as const) {
    const share = Bps.from(value);
    assert.equal(share.bps, 1530);
    assert.equal(share.toString(), '1530');
  }
  assert.equal(new Bps(1530).bps, 1530);
  assert.equal(bps(1530).bps, 1530);
  assert.equal(createBps(1530).bps, 1530);
});

test('the absent share is zero, from every door that admits it', () => {
  for (const share of [Bps.from(null), new Bps(), createBps()]) {
    assert.equal(share.bps, 0);
    assert.equal(share.toString(), '0');
    assert.equal(share.isZero(), true);
    assert.equal(share.isWhole(), false);
  }
});

test('the wire form is the bare integer, as shareBps rides on an operation', () => {
  assert.equal(bps(10_000).toString(), '10000');
  assert.equal(bps(10_000).toJSON(), 10_000);
  assert.equal(
    JSON.stringify({ sellerId: 'usr_seller', shareBps: bps(10_000) }),
    '{"sellerId":"usr_seller","shareBps":10000}',
  );
  assert.equal(bps(10_000).isWhole(), true);
  assert.equal(Bps.WHOLE, 10_000);
});

test('share() agrees with the lab on the same inputs', () => {
  const counts = [0, 1, 1_530, 2_500, 3_000, 3_333, 9_999, 10_000];
  const minors = [100_000n, 99_999n, 1n, 0n, -100_000n, 2_000_000n, 7n];
  for (const count of counts) {
    for (const minor of minors) {
      const amount = toAmount('CREDIT', minor);
      assert.equal(
        bps(count).share(Money.from(amount)).toString(),
        encodeAmount(convertFloor(amount, asRate(count), 'CREDIT')),
        `${count} bps of ${minor}`,
      );
    }
  }
});

test('fee() agrees with the lab on the same inputs', () => {
  const counts = [0, 1, 1_530, 2_500, 3_333, 9_999, 10_000];
  const minors = [100_000n, 99_999n, 100_050n, 50n, 1n, 0n, 2_000_000n];
  for (const count of counts) {
    for (const minor of minors) {
      const amount = toAmount('CREDIT', minor);
      assert.equal(
        bps(count).fee(Money.from(amount)).toString(),
        encodeAmount(toAmount('CREDIT', feeForPrice(amount, count))),
        `${count} bps on ${minor}`,
      );
    }
  }
});

test('fee() rounds up to a whole credit and never exceeds the price', () => {
  // The two rules that make re-deriving a fee wrong: 15.3% of 1,000.50 is 153.0765, which the
  // ledger takes as 154.00, and a fee larger than the price is capped at the price.
  assert.equal(bps(1_530).fee('CREDIT:1000.00').toString(), 'CREDIT:153.00');
  assert.equal(bps(1_530).fee('CREDIT:1000.50').toString(), 'CREDIT:154.00');
  assert.equal(bps(1_530).fee('CREDIT:0.50').toString(), 'CREDIT:0.50');
  assert.equal(bps(0).fee('CREDIT:1000.00').toString(), 'CREDIT:0.00');
});

test('fee() and revenue() refuse a currency the whole-credit rounding cannot fit', () => {
  // Rounding up to a whole unit is a rule about credits. On dollars it takes USD:1.00 from a
  // USD:1.07 price — 93% — and the price cap does not catch it, so the door refuses instead.
  // `share()` stays currency-agnostic: a fraction rounded down needs no whole unit.
  assert.throws(() => bps(1_530).fee('USD:1.07'), { code: 'OP.MALFORMED' });
  assert.throws(() => bps(1_530).fee('USD:100.00'), { code: 'OP.MALFORMED' });
  assert.throws(() => bps(1_530).revenue('USD:1.07', [bps(10_000)]), {
    code: 'OP.MALFORMED',
  });
  assert.equal(bps(1_530).share('USD:100.00').toString(), 'USD:15.30');
});

test('revenue() agrees with the lab on the same inputs', () => {
  const splits = [
    [10_000],
    [5_000, 5_000],
    [3_333, 3_333, 3_334],
    [1, 9_999],
    [],
  ];
  for (const shares of splits) {
    for (const minor of [100_000n, 99_999n, 1n, 0n]) {
      const price = toAmount('CREDIT', minor);
      const recipients = shares.map((shareBps) => ({
        sellerId: 'usr_seller',
        shareBps,
      }));
      assert.equal(
        bps(1_530).revenue(Money.from(price), shares).toString(),
        encodeAmount(
          toAmount('CREDIT', revenueForSplit(price, recipients, 1_530)),
        ),
        `${shares.join('/')} of ${minor}`,
      );
    }
  }
});

test('revenue() keeps the fee plus the residual an uneven split leaves', () => {
  // 999.99 at a 15.3% fee leaves 846.99 to divide three uneven ways. Each share rounds down, and
  // revenue takes what is left over on top of its fee, so the sale still sums to its price.
  const shares = [bps(3_333), bps(3_333), bps(3_334)];
  const price = Money.from('CREDIT:999.99');
  const fee = bps(1_530).fee(price);
  const revenue = bps(1_530).revenue(price, shares);
  const paid = shares.reduce(
    (total, share) => total.add(share.share(price.subtract(fee))),
    Money.from('CREDIT:0.00'),
  );
  assert.equal(fee.toString(), 'CREDIT:153.00');
  assert.equal(paid.toString(), 'CREDIT:846.98');
  assert.equal(revenue.toString(), 'CREDIT:153.01');
  assert.equal(paid.add(revenue).toString(), price.toString());
});

test('share() rounds down, leaving the remainder behind', () => {
  // A 30% share of 1,000 credits is exact; a 33.33% share is not, and the fraction is dropped
  // rather than rounded up, which is why an uneven split leaves a residual for revenue.
  assert.equal(bps(3_000).share('CREDIT:1000.00').toString(), 'CREDIT:300.00');
  assert.equal(bps(3_333).share('CREDIT:1000.00').toString(), 'CREDIT:333.30');
  assert.equal(bps(1).share('CREDIT:0.01').toString(), 'CREDIT:0.00');
  assert.equal(bps(10_000).share('CREDIT:600.00').toString(), 'CREDIT:600.00');
  assert.equal(bps(0).share('CREDIT:600.00').toString(), 'CREDIT:0.00');
});

test('an even three-way split hands out the whole net; an uneven one leaves a residual', () => {
  const net = Money.from('CREDIT:900.00');
  const even = [bps(5_000), bps(2_500), bps(2_500)];
  Bps.assertShareSum(even);
  const paid = even.reduce(
    (total, share) => total.add(share.share(net)),
    Money.from('CREDIT:0.00'),
  );
  assert.equal(paid.toString(), 'CREDIT:900.00');
  assert.equal(net.subtract(paid).isZero(), true);

  // A net that thirds do not divide: each share floors and the lost fractions add up.
  const odd = Money.from('CREDIT:999.99');
  const uneven = [bps(3_333), bps(3_333), bps(3_334)];
  Bps.assertShareSum(uneven);
  const unevenPaid = uneven.reduce(
    (total, share) => total.add(share.share(odd)),
    Money.from('CREDIT:0.00'),
  );
  assert.equal(unevenPaid.toString(), 'CREDIT:999.97');
  // The ledger credits this residual to platform revenue so no minor unit of a sale is lost.
  assert.equal(odd.subtract(unevenPaid).toString(), 'CREDIT:0.02');
});

test('share() keeps the currency of the amount it divides', () => {
  assert.equal(bps(2_500).share('USD:100.00').toString(), 'USD:25.00');
  assert.equal(bps(2_500).share('CREDIT:100.00').currency, 'CREDIT');
});

test('a split spelled shareBps is refused, not booked whole to the platform', () => {
  // `shareBps` is what an operation carries and what revenue() builds internally, so it is the
  // likely misspelling. Read as zero it pays every seller nothing and hands the platform the
  // entire price, and the split still sums to the whole.
  const misspelt = [
    { sellerId: 'a', shareBps: 5_000 },
    { sellerId: 'b', shareBps: 5_000 },
  ] as unknown as ReadonlyArray<number>;

  assert.throws(
    () => bps(1_530).revenue('CREDIT:1000.00', misspelt),
    { code: 'OP.MALFORMED' },
    'a share the split cannot read is a malformed operation',
  );
  assert.throws(() => Bps.from(misspelt[0]!), { code: 'OP.MALFORMED' });

  // The control: the same split spelled `bps` keeps the fee it always kept.
  assert.equal(
    bps(1_530)
      .revenue('CREDIT:1000.00', [{ bps: 5_000 }, { bps: 5_000 }])
      .toString(),
    'CREDIT:153.00',
  );
});

test('shares must sum to 10000, in the ledger own words', () => {
  Bps.assertShareSum([]);
  Bps.assertShareSum([bps(10_000)]);
  Bps.assertShareSum([5_000, 5_000]);
  Bps.assertShareSum([{ bps: 7_000 }, { bps: 3_000 }]);
  for (const shares of [[bps(5_000)], [bps(5_000), bps(4_999)], [bps(1)]]) {
    assert.throws(
      () => Bps.assertShareSum(shares),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'OP.MALFORMED');
        assert.match(error.message, /Recipient shareBps must sum to 10000\./);
        return true;
      },
    );
  }
});

// A rate of zero is a legitimate fee. A recipient share of zero is not, and the ledger has
// always refused it — this check used to pass one through to fault at the posting instead.
test('a share of zero is refused here, the way the ledger refuses it', () => {
  for (const shares of [
    [bps(0), bps(10_000)],
    [bps(10_000), bps(0)],
    [0, 5_000, 5_000],
    [{ bps: 0 }, { bps: 10_000 }],
  ]) {
    assert.throws(
      () => Bps.assertShareSum(shares),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'OP.MALFORMED');
        assert.match(
          error.message,
          /Each recipient share must be more than 0\./,
        );
        return true;
      },
    );
  }
  // A zero rate is still fine: the refusal is about shares, not about basis points.
  assert.equal(bps(0).bps, 0);
});

test('a malformed share throws OP.MALFORMED with a named message', () => {
  const cases: unknown[] = [
    10_001,
    -1,
    1.5,
    Number.NaN,
    '1.5',
    '',
    ' ',
    '1e3',
    '-1',
    { bps: 10_001 },
  ];
  for (const value of cases) {
    assert.throws(
      () => Bps.from(value as number),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'OP.MALFORMED', String(value));
        assert.match(
          error.message,
          /Basis points must be a whole number from 0 to 10000\./,
        );
        return true;
      },
      String(value),
    );
  }
});

test('from() hands an existing Bps straight back, since a Bps cannot change', () => {
  const share = bps(1_530);
  assert.equal(Bps.from(share), share);
  assert.equal(createBps(share), share);
});

test('the constructor refuses everything from() refuses, empty string included', () => {
  assert.throws(() => new Bps(''), /Basis points must be a whole number/);
  assert.throws(() => new Bps('1.5'), /Basis points must be a whole number/);
  assert.throws(() => new Bps(10_001), /Basis points must be a whole number/);
  // Only a wholly absent value is zero.
  assert.equal(new Bps().bps, 0);
  assert.equal(new Bps(0).bps, 0);
  assert.equal(Bps.from(null).bps, 0);
});

test('a share that cannot be read throws, never zero', () => {
  // A silent zero is the one outcome a share value must never produce: it turns a seller's cut
  // into nothing and still lets the split look well formed. An object carrying no readable
  // `bps` is that case, and it is the one a caller reaches by accident.
  const cases: unknown[] = [
    5_000n,
    true,
    false,
    [],
    [10_000],
    () => 1,
    Symbol('x'),
    {},
    { bps: undefined },
    { bps: null },
    { sellerId: 'a', shareBps: 5_000 },
  ];
  for (const value of cases) {
    assert.throws(
      () => Bps.from(value as number),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'OP.MALFORMED', String(value));
        assert.match(
          error.message,
          /Basis points must be a whole number from 0 to 10000\./,
        );
        return true;
      },
      String(value),
    );
  }
  assert.equal(cases.length, 11);

  // The message says a whole number is wanted, which reads as false to a caller who wrote
  // `shareBps: 5_000`. The detail names the keys they did carry, so the mistake is the object
  // and not the count.
  assert.throws(
    () => Bps.from({ sellerId: 'a', shareBps: 5_000 } as never),
    (error: Error & { detail?: Record<string, unknown> }) => {
      assert.equal(error.detail?.bps, '{sellerId, shareBps}');
      return true;
    },
  );
  assert.throws(
    () => Bps.from('1.5'),
    (error: Error & { detail?: Record<string, unknown> }) => {
      assert.equal(error.detail?.bps, '1.5');
      return true;
    },
  );
});

test('assertShareSum refuses a junk share rather than counting it as nothing', () => {
  // 10,000 plus a share that reads as zero sums to the whole, so a junk recipient would pass
  // the one check that exists to catch a split that does not add up.
  for (const shares of [
    [bps(10_000), [] as never],
    [{ bps: 10_000 }, 5_000n as never],
    [bps(10_000), true as never],
    [bps(10_000), { sellerId: 'a', shareBps: 5_000 } as never],
    [bps(10_000), {} as never],
  ]) {
    assert.throws(() => Bps.assertShareSum(shares), {
      code: 'OP.MALFORMED',
    });
  }
  // And a shares list that is not a list at all faults in the same vocabulary.
  assert.throws(() => Bps.assertShareSum(7 as never), {
    code: 'OP.MALFORMED',
  });
  assert.throws(() => Bps.assertShareSum(null as never), {
    code: 'OP.MALFORMED',
  });
});
