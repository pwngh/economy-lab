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
  add as addAmounts,
  compare as compareAmounts,
  credits as creditAmount,
  decodeAmountWire,
  encodeAmount,
  isZero as isZeroAmount,
  negate,
  toAmount,
  usd as usdAmount,
} from '@pwngh/economy-lab';
import type { Currency } from '@pwngh/economy-lab';

import { Money, createMoney, credits, usd } from '../src/index.js';

// The lab publishes Currency as a type-only union with no runtime list, so the two directions
// are pinned separately: `satisfies` refuses a tag the lab does not have, and UNHANDLED stops
// compiling the day the lab gains one this list has not been taught.
const CURRENCIES = ['CREDIT', 'USD'] as const satisfies readonly Currency[];
const UNHANDLED: never[] = [] as Exclude<
  Currency,
  (typeof CURRENCIES)[number]
>[];
void UNHANDLED;
const I64_MAX = 2n ** 63n - 1n;
const I64_MIN = -(2n ** 63n);

test('every currency in the union round-trips through the wire', () => {
  for (const currency of CURRENCIES) {
    for (const minor of [0n, 1n, -1n, 60_000n, 2_000_000n]) {
      const wire = encodeAmount(toAmount(currency, minor));
      const money = Money.from(wire);
      assert.equal(money.currency, currency);
      assert.equal(money.minor, minor);
      assert.equal(money.toString(), wire);
      assert.equal(Money.from(money.toString()).minor, minor);
    }
  }
});

test('from() takes a wire string, an init object, and a lab Amount alike', () => {
  const fromString = Money.from('CREDIT:600.00');
  const fromMinor = Money.from({ currency: 'CREDIT', minor: 60_000n });
  const fromDecimal = Money.from({ currency: 'CREDIT', decimal: '600.00' });
  const fromAmount = Money.from(creditAmount(600));

  for (const money of [fromMinor, fromDecimal, fromAmount]) {
    assert.equal(money.toString(), fromString.toString());
    assert.equal(money.minor, 60_000n);
    assert.equal(money.currency, 'CREDIT');
  }
});

test('the constructor delegates to from(), and both factories match it', () => {
  assert.equal(new Money('USD:9.99').toString(), 'USD:9.99');
  assert.equal(new Money({ currency: 'USD', minor: 999n }).minor, 999n);
  assert.equal(createMoney('USD:9.99').toString(), 'USD:9.99');
  assert.equal(Money.from(credits(20_000)).toString(), 'CREDIT:20000.00');
  assert.equal(Money.from(usd('9.99')).toString(), 'USD:9.99');
});

// One `credits` in the ecosystem, and it lives at this door: the export is the lab function
// itself, so an amount built here is the amount an operation constructor takes.
test('credits and usd are the lab constructors, re-exported verbatim', () => {
  assert.equal(credits, creditAmount);
  assert.equal(usd, usdAmount);
  assert.deepEqual(credits(600), creditAmount(600));
});

test('the absent value is zero credits, from every door that admits it', () => {
  for (const money of [Money.from(null), new Money(), createMoney()]) {
    assert.equal(money.toString(), 'CREDIT:0.00');
    assert.equal(money.minor, 0n);
    assert.equal(money.isZero(), true);
  }
});

test('currency defaults to CREDIT when the init object omits it', () => {
  assert.equal(Money.from({ minor: 60_000n }).toString(), 'CREDIT:600.00');
  assert.equal(Money.from({ decimal: '600.00' }).currency, 'CREDIT');
});

test('toString() is canonical and stable across re-parses', () => {
  const wire = 'USD:100.00';
  let money = Money.from(wire);
  for (let pass = 0; pass < 4; pass += 1) {
    assert.equal(money.toString(), wire);
    money = Money.from(money.toString());
  }
  // The tag rides along, so `${money}` and JSON.stringify both carry the currency.
  assert.equal(`${Money.from('CREDIT:600.00')}`, 'CREDIT:600.00');
  assert.equal(
    JSON.stringify({ price: Money.from('CREDIT:600.00') }),
    '{"price":"CREDIT:600.00"}',
  );
});

test('decimal drops the tag and keeps both places', () => {
  assert.equal(Money.from('USD:100.00').decimal, '100.00');
  assert.equal(Money.from('CREDIT:-0.05').decimal, '-0.05');
  assert.equal(Money.from({ currency: 'USD', minor: 5n }).decimal, '0.05');
});

test('amount hands back the branded value the lab built', () => {
  const money = Money.from('CREDIT:600.00');
  assert.deepEqual(money.amount, creditAmount(600));
  assert.equal(encodeAmount(money.amount), money.toString());
});

test('add and subtract agree with the lab on the same inputs', () => {
  const pairs: [string, string][] = [
    ['CREDIT:20000.00', 'CREDIT:600.00'],
    ['CREDIT:0.01', 'CREDIT:-0.02'],
    ['USD:100.00', 'USD:9.99'],
  ];
  for (const [left, right] of pairs) {
    const a = decodeAmountWire(left);
    const b = decodeAmountWire(right);
    assert.equal(
      Money.from(left).add(right).minor,
      addAmounts(a, b).minor,
      `add ${left} ${right}`,
    );
    assert.equal(
      Money.from(left).subtract(right).minor,
      addAmounts(a, negate(b)).minor,
      `subtract ${left} ${right}`,
    );
    assert.equal(
      Money.from(left).add(right).toString(),
      encodeAmount(addAmounts(a, b)),
    );
  }
});

test('compare, equals, and isZero agree with the lab on the same inputs', () => {
  const values = [
    'CREDIT:0.00',
    'CREDIT:0.01',
    'CREDIT:600.00',
    'CREDIT:-0.05',
  ];
  for (const left of values) {
    for (const right of values) {
      const a = decodeAmountWire(left);
      const b = decodeAmountWire(right);
      assert.equal(
        Money.from(left).compare(right),
        compareAmounts(a, b),
        `compare ${left} ${right}`,
      );
      assert.equal(
        Money.from(left).equals(right),
        compareAmounts(a, b) === 0,
        `equals ${left} ${right}`,
      );
    }
    assert.equal(
      Money.from(left).isZero(),
      isZeroAmount(decodeAmountWire(left)),
    );
  }
});

test('the arithmetic takes a Money, an amount, a string, or an init object identically', () => {
  const base = Money.from(credits(20_000));
  const sums = [
    base.add(credits(600)),
    base.add('CREDIT:600.00'),
    base.add({ currency: 'CREDIT', minor: 60_000n }),
  ];
  for (const sum of sums) {
    assert.equal(sum.toString(), 'CREDIT:20600.00');
  }
  assert.equal(
    base.toString(),
    'CREDIT:20000.00',
    'the operand is not mutated',
  );
});

test('equals is false across currencies where compare throws', () => {
  const price = Money.from('CREDIT:100.00');
  const cash = Money.from('USD:100.00');
  assert.equal(price.equals(cash), false);
  assert.throws(
    () => price.compare(cash),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'LEDGER.CURRENCY_MISMATCH');
      assert.match(error.message, /Cannot combine CREDIT with USD\./);
      return true;
    },
  );
  assert.throws(() => price.add(cash), /Cannot combine CREDIT with USD\./);
});

test('malformed wire input throws MONEY.INVALID_AMOUNT with a named message', () => {
  const cases: [string, RegExp][] = [
    ['EUR:1.00', /Not an encoded amount: EUR:1\.00\./],
    ['600.00', /Not an encoded amount: 600\.00\./],
    ['', /Not an encoded amount: \./],
    ['CREDIT:1.005', /Not a 2-decimal money string: 1\.005\./],
    ['CREDIT:1,000.00', /Not a 2-decimal money string: 1,000\.00\./],
    ['CREDIT:six hundred', /Not a 2-decimal money string: six hundred\./],
  ];
  for (const [wire, message] of cases) {
    assert.throws(
      () => Money.from(wire),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'MONEY.INVALID_AMOUNT', wire);
        assert.match(error.message, message);
        return true;
      },
      wire,
    );
  }
});

test('a malformed init object throws MONEY.INVALID_AMOUNT too', () => {
  assert.throws(
    () => Money.from({ currency: 'CREDIT', minor: 1n, decimal: '0.01' }),
    /Money takes minor units or a decimal string, not both\./,
  );
  assert.throws(
    () => Money.from({ currency: 'CREDIT', decimal: '1.005' }),
    /Not a 2-decimal money string: 1\.005\./,
  );
  // A currency the ledger does not handle is refused even when TypeScript is not watching.
  assert.throws(
    () => Money.from({ currency: 'EUR' as Currency, minor: 100n }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'MONEY.INVALID_AMOUNT');
      return true;
    },
  );
});

// A decoded JSON body is untyped, and this package exists to sit on a wire, so the init fields
// are checked at run time and not only by the compiler nobody ran over the request.
test('an init field of the wrong primitive is refused, never quietly coerced', () => {
  const wrongMinor = [1, 1.5, 2 ** 53 + 1, '60000', true, {}, []];
  for (const minor of wrongMinor) {
    assert.throws(
      () => Money.from({ minor: minor as never }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'MONEY.INVALID_AMOUNT', String(minor));
        assert.match(
          error.message,
          /minor units must be a bigint/,
          String(minor),
        );
        return true;
      },
      String(minor),
    );
  }
  for (const decimal of [5, 600, 0.1 + 0.2, 60_000n, true, null, {}]) {
    assert.throws(
      () => Money.from({ decimal: decimal as never }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'MONEY.INVALID_AMOUNT', String(decimal));
        assert.match(
          error.message,
          /decimal must be a two-place decimal string/,
          String(decimal),
        );
        return true;
      },
      String(decimal),
    );
  }
  // 2^53 + 1 is the value the number door loses: it arrives already rounded down by one.
  assert.equal(
    Money.from({ minor: 2n ** 53n + 1n }).minor,
    9_007_199_254_740_993n,
  );
  // An absent minor is still zero, the reading the module gives every absent amount.
  assert.equal(Money.from({ minor: undefined }).toString(), 'CREDIT:0.00');
  assert.equal(Money.from({ minor: null as never }).toString(), 'CREDIT:0.00');
});

test('a value past the 64-bit range the ledger stores throws MONEY.OVERFLOW', () => {
  assert.throws(
    () => Money.from({ currency: 'CREDIT', minor: I64_MAX + 1n }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'MONEY.OVERFLOW');
      return true;
    },
  );
  assert.throws(
    () => Money.from({ currency: 'CREDIT', minor: I64_MIN - 1n }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'MONEY.OVERFLOW');
      return true;
    },
  );
  // The lab's decimal parser refuses an out-of-range literal on its own, before the brand's
  // range check ever sees it, so the wire path faults as a bad string rather than an overflow.
  assert.throws(
    () => Money.from(`CREDIT:${I64_MAX + 1n}.00`),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'MONEY.INVALID_AMOUNT');
      return true;
    },
  );
});

test('bigint precision holds at the 64-bit bounds, with no float drift', () => {
  for (const minor of [
    I64_MAX,
    I64_MIN,
    I64_MAX - 1n,
    9_007_199_254_740_993n,
  ]) {
    const money = Money.from({ currency: 'CREDIT', minor });
    assert.equal(money.minor, minor);
    assert.equal(Money.from(money.toString()).minor, minor);
    assert.equal(money.toString(), encodeAmount(toAmount('CREDIT', minor)));
  }
  // 2^53 + 1 is the first integer a double cannot name; the wire keeps every digit of it.
  assert.equal(
    Money.from({
      currency: 'CREDIT',
      minor: 9_007_199_254_740_993n,
    }).toString(),
    'CREDIT:90071992547409.93',
  );
  // Summing a cent onto the largest storable value stays exact rather than rounding away.
  assert.equal(
    Money.from({ currency: 'CREDIT', minor: I64_MAX - 1n }).add({
      currency: 'CREDIT',
      minor: 1n,
    }).minor,
    I64_MAX,
  );
});

test('a payout-scale conversion keeps its cents through the wire', () => {
  // 20,000 credits cash out to $100.00 at the $0.005-per-credit rate.
  const payout = Money.from(usd('100.00'));
  assert.equal(payout.toString(), 'USD:100.00');
  assert.equal(payout.minor, 10_000n);
  assert.equal(payout.subtract('USD:0.01').toString(), 'USD:99.99');
});

test('from() hands an existing Money straight back, since a Money cannot change', () => {
  const money = Money.from('CREDIT:600.00');
  assert.equal(Money.from(money), money);
  assert.equal(createMoney(money), money);
});

test('the constructor refuses everything from() refuses, empty string included', () => {
  // A truthiness guard would let '' past, and '' is what an absent wire field arrives as.
  assert.throws(() => new Money(''), /Not an encoded amount: \./);
  assert.throws(() => createMoney(''), /Not an encoded amount: \./);
  assert.throws(
    () => new Money('CREDIT:1.005'),
    /Not a 2-decimal money string/,
  );
  // Only a wholly absent value is zero, and that is the documented reading of an absent field.
  assert.equal(new Money().toString(), 'CREDIT:0.00');
  assert.equal(Money.from(null).toString(), 'CREDIT:0.00');
});

test('a value that is neither a wire string nor an init object throws, never zero', () => {
  // Money.from(600) is the mistake a caller actually makes. Reading it as zero would hand back
  // a legal-looking amount of no money instead of naming the fault.
  const cases: unknown[] = [600, 0, true, [], 5n, () => 1, Symbol('x')];
  for (const value of cases) {
    assert.throws(
      () => Money.from(value as string),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'MONEY.INVALID_AMOUNT', String(value));
        assert.match(
          error.message,
          /Money takes a CURRENCY:decimal string or an init object/,
        );
        return true;
      },
      String(value),
    );
  }
  assert.equal(cases.length, 7);
  // An init object that names nothing is still an init object: zero of the default currency.
  assert.equal(Money.from({}).toString(), 'CREDIT:0.00');
});

test('the amount handed out cannot be used to change the money', () => {
  // from() returns the same instance for a Money, so a writable amount would let one holder
  // rewrite a value every other holder is reading.
  const money = Money.from('CREDIT:600.00');
  const shared = Money.from(money);

  assert.throws(() => {
    (money.amount as { minor: bigint }).minor = 1n;
  }, TypeError);

  assert.equal(money.minor, 60_000n);
  assert.equal(money.toString(), 'CREDIT:600.00');
  assert.equal(shared.toString(), 'CREDIT:600.00');
  assert.equal(Object.isFrozen(money.amount), true);
  assert.equal(Object.isFrozen(new Money().amount), true);
});

test('compare orders by minor units, at values the lab cannot also be wrong about', () => {
  // Checking compare against the lab's compare would agree with itself however either behaves.
  // These are the orderings themselves.
  assert.equal(Money.from('CREDIT:100.00').compare('CREDIT:600.00'), -1);
  assert.equal(Money.from('CREDIT:600.00').compare('CREDIT:100.00'), 1);
  assert.equal(Money.from('CREDIT:600.00').compare('CREDIT:600.00'), 0);
  assert.equal(Money.from('CREDIT:-0.05').compare('CREDIT:0.00'), -1);
  assert.equal(Money.from('USD:100.00').compare('USD:99.99'), 1);
  assert.deepEqual(
    ['CREDIT:3.00', 'CREDIT:-1.00', 'CREDIT:2.00']
      .map((wire) => Money.from(wire))
      .sort((a, b) => a.compare(b))
      .map((money) => money.toString()),
    ['CREDIT:-1.00', 'CREDIT:2.00', 'CREDIT:3.00'],
  );
  assert.equal(Money.from('CREDIT:600.00').equals('CREDIT:600.00'), true);
  assert.equal(Money.from('CREDIT:600.00').equals('CREDIT:600.01'), false);
});
