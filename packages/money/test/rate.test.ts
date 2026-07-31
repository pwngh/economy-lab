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
  convertCeil,
  convertFloor,
  encodeAmount,
  rateGte,
  toAmount,
} from '@pwngh/economy-lab';
import { encodeAmounts } from '@pwngh/economy-lab/store-kit';

import { Money, Rate, createRate } from '../src/index.js';

// The three rates a deployment configures: buy at ~120 credits per dollar, backed and cashed
// out at $0.005 per credit. The ids are the ones the lab's rates adapter mints.
const PAYOUT = {
  rate: 5n,
  scale: 3,
  rateId: 'payout:CREDIT->USD:5/3',
};
const BUY = {
  rate: 8333n,
  scale: 6,
  rateId: 'buy:CREDIT->USD:8333/6',
};

test('a rate round-trips the exact body GET /v1/rates sends', () => {
  // The server builds its response by running the rates port through the lab's own encoder, so
  // this is the real wire shape rather than a guess at it.
  const body = encodeAmounts({ buy: BUY, payout: PAYOUT }) as Record<
    string,
    unknown
  >;
  assert.equal(
    JSON.stringify(body),
    '{"buy":{"rate":"8333","scale":6,"rateId":"buy:CREDIT->USD:8333/6"},' +
      '"payout":{"rate":"5","scale":3,"rateId":"payout:CREDIT->USD:5/3"}}',
  );

  const payout = Rate.from(body.payout as string);
  assert.equal(payout.rate, 5n);
  assert.equal(payout.scale, 3);
  assert.equal(payout.rateId, 'payout:CREDIT->USD:5/3');
  assert.deepEqual(payout.toJSON(), body.payout);
  assert.equal(payout.toString(), JSON.stringify(body.payout));
  assert.equal(Rate.from(payout.toString()).rate, 5n);
});

test('from() takes the wire JSON, an init object, and a lab Rate alike', () => {
  const wire = Rate.from(
    '{"rate":"5","scale":3,"rateId":"payout:CREDIT->USD:5/3"}',
  );
  const fromInit = Rate.from({ rate: '5', scale: 3, rateId: PAYOUT.rateId });
  const fromLab = Rate.from(PAYOUT);
  const fromBigint = Rate.from({ rate: 5n, scale: 3, rateId: PAYOUT.rateId });

  for (const rate of [wire, fromInit, fromLab, fromBigint]) {
    assert.equal(rate.rate, 5n);
    assert.equal(rate.scale, 3);
    assert.equal(rate.rateId, 'payout:CREDIT->USD:5/3');
  }
  assert.equal(new Rate(PAYOUT).rateId, PAYOUT.rateId);
  assert.equal(createRate(PAYOUT).rateId, PAYOUT.rateId);
});

test('the rateId passes through byte for byte, never rebuilt', () => {
  // Every id below is one a normalizing rebuild would change: pure-ASCII ids alone cannot tell
  // a passthrough apart from a trim-and-normalize.
  const ids = [
    'payout:CREDIT->USD:5/3',
    'buy:CREDIT->USD:8333/6',
    'par:CREDIT->USD:5/3',
    'USD->USD:1',
    'cashout-example',
    ' payout:CREDIT->USD:5/3 ',
    'ﬁxed:CREDIT->USD:5/3',
    'ＵＳＤ->USD:1',
    'payout:CREDIT->USD:5/3\n',
  ];
  for (const rateId of ids) {
    const rate = Rate.from({ rate: 5n, scale: 3, rateId });
    assert.equal(rate.rateId, rateId);
    assert.equal(Rate.from(rate.toString()).rateId, rateId);
    assert.equal(JSON.parse(rate.toString()).rateId, rateId);
  }
});

test('convertFloor and convertCeil agree with the lab on the same inputs', () => {
  const cases: [typeof PAYOUT, bigint][] = [
    [PAYOUT, 2_000_000n],
    [PAYOUT, 2_000_100n],
    [PAYOUT, 1n],
    [PAYOUT, 0n],
    [PAYOUT, -2_000_100n],
    [BUY, 12_000n],
  ];
  for (const [config, minor] of cases) {
    const rate = Rate.from(config);
    const amount = toAmount('CREDIT', minor);
    const label = `${config.rateId} ${minor}`;
    assert.equal(
      rate.convertFloor(Money.from(amount), 'USD').toString(),
      encodeAmount(convertFloor(amount, config, 'USD')),
      `floor ${label}`,
    );
    assert.equal(
      rate.convertCeil(Money.from(amount), 'USD').toString(),
      encodeAmount(convertCeil(amount, config, 'USD')),
      `ceil ${label}`,
    );
  }
});

test('a Rate instance is accepted by the lab functions unchanged', () => {
  const rate = Rate.from(PAYOUT);
  // No unwrapping step: the class satisfies the lab's own Rate type.
  const direct = convertFloor(toAmount('CREDIT', 2_000_000n), rate, 'USD');
  assert.equal(encodeAmount(direct), 'USD:100.00');
  assert.equal(
    rate.convertFloor('CREDIT:20000.00', 'USD').toString(),
    'USD:100.00',
  );
});

test('the payout direction floors and the trust direction ceils', () => {
  const rate = Rate.from(PAYOUT);
  // $100.005 exactly: the two directions must disagree by one cent, never silently pick one.
  assert.equal(
    rate.convertFloor('CREDIT:20001.00', 'USD').toString(),
    'USD:100.00',
  );
  assert.equal(
    rate.convertCeil('CREDIT:20001.00', 'USD').toString(),
    'USD:100.01',
  );
});

test('a missing rate throws instead of pricing at one-for-one', () => {
  assert.throws(
    () => Rate.from(null),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'CONFIG.INVALID');
      assert.match(
        error.message,
        /A rate must be named; there is no default rate\./,
      );
      return true;
    },
  );
});

test('a rate missing its scale throws instead of pricing at the raw multiplier', () => {
  // Every rate on the wire carries all three fields, so a body without `scale` lost one on the
  // way. Reading it as 0 is not the one-for-one the null case refuses: it is the multiplier raw,
  // 10^scale too high, and in the payout direction. $5.00 a credit instead of $0.005.
  const doors: (() => unknown)[] = [
    () => Rate.from('{"rate":"5","rateId":"payout:CREDIT->USD:5/3"}'),
    // @ts-expect-error scale is required; the call still runs, so the throw is pinned
    () => Rate.from({ rate: '5', rateId: PAYOUT.rateId }),
    // @ts-expect-error scale is required; the call still runs, so the throw is pinned
    () => new Rate({ rate: 5n, rateId: PAYOUT.rateId }),
    // @ts-expect-error scale is required; the call still runs, so the throw is pinned
    () => createRate({ rate: 5n, rateId: PAYOUT.rateId }),
    () => Rate.from({ rate: 5n, scale: null as never, rateId: PAYOUT.rateId }),
  ];
  for (const [index, door] of doors.entries()) {
    assert.throws(
      door,
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CONFIG.INVALID', `door ${index}`);
        assert.equal(
          error.message,
          'A rate must carry the scale its multiplier divides by; there is no default scale.',
          `door ${index}`,
        );
        return true;
      },
      `door ${index}`,
    );
  }
  assert.equal(doors.length, 5, `checked ${doors.length} doors`);

  // The positive control on the refusal: scale 0 is a real rate, so what is refused above is the
  // field being absent and not the value it would have defaulted to. Same multiplier, same
  // 20,000 credits, three orders of magnitude between the two prices.
  assert.equal(
    Rate.from({ rate: '5', scale: 0, rateId: 'raw:CREDIT->USD:5/0' })
      .convertFloor('CREDIT:20000.00', 'USD')
      .toString(),
    'USD:100000.00',
  );
  assert.equal(
    Rate.from({ rate: '5', scale: 3, rateId: PAYOUT.rateId })
      .convertFloor('CREDIT:20000.00', 'USD')
      .toString(),
    'USD:100.00',
  );
});

test('every field of RateInit is required on its own, not two of the three', () => {
  // A blank init object fails to compile while any one field is required, so a blank-object pin
  // cannot say which. Each case here is short exactly one field, so its directive goes unused the
  // moment that field turns optional again.
  const short: (() => unknown)[] = [
    // @ts-expect-error rate is required; the call still runs, so the throw is pinned
    () => Rate.from({ scale: 3, rateId: PAYOUT.rateId }),
    // @ts-expect-error scale is required; the call still runs, so the throw is pinned
    () => Rate.from({ rate: 5n, rateId: PAYOUT.rateId }),
    // @ts-expect-error rateId is required; the call still runs, so the throw is pinned
    () => Rate.from({ rate: 5n, scale: 3 }),
  ];
  for (const [index, build] of short.entries()) {
    assert.throws(
      build,
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CONFIG.INVALID', `field ${index}`);
        return true;
      },
      `field ${index}`,
    );
  }
  // One case per field RateInit declares: rate, scale, rateId.
  assert.equal(short.length, 3);
});

test('a malformed rate throws CONFIG.INVALID with a named message', () => {
  const cases: [unknown, RegExp][] = [
    [
      { rate: 5n, scale: 3 },
      /A rate must carry the rateId the ledger minted for it\./,
    ],
    [{ rate: 5n, scale: 3, rateId: '' }, /A rate must carry the rateId/],
    [
      { scale: 3, rateId: 'x' },
      /Rate multiplier must be a bigint or a string of digits/,
    ],
    [
      { rate: -5n, scale: 3, rateId: 'x' },
      /Rate multiplier must not be negative\./,
    ],
    [{ rate: '5.5', scale: 3, rateId: 'x' }, /a string of digits/],
    [
      { rate: 5n, scale: -1, rateId: 'x' },
      /Rate scale must be a whole number from 0 to 38\./,
    ],
    [{ rate: 5n, scale: 39, rateId: 'x' }, /from 0 to 38/],
    [{ rate: 5n, scale: 1.5, rateId: 'x' }, /whole number/],
    ['not json', /Not an encoded rate object\./],
    ['[1,2]', /Not an encoded rate object\./],
    ['null', /Not an encoded rate object\./],
  ];
  cases.forEach(([value, message], index) => {
    const label = `case ${index}`;
    assert.throws(
      () => Rate.from(value as string),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CONFIG.INVALID', label);
        assert.match(error.message, message);
        return true;
      },
      label,
    );
  });
});

test('a wrong-typed multiplier is told the rule it broke, not one it kept', () => {
  // 5 is a whole number and is not negative, so the old wording named neither the fault nor
  // the fix. What a plain number is not is a bigint or a string of digits.
  const wrongType =
    'Rate multiplier must be a bigint or a string of digits; JSON cannot carry the exact integer.';
  for (const rate of [5, 5.5, '5.5', '-5', null, true, {}]) {
    assert.throws(
      () => Rate.from({ rate: rate as never, scale: 3, rateId: 'x' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CONFIG.INVALID', String(rate));
        assert.equal(error.message, wrongType, String(rate));
        return true;
      },
      String(rate),
    );
  }
  // A negative bigint is the one case the old wording actually described, and it keeps it.
  assert.throws(
    () => Rate.from({ rate: -5n, scale: 3, rateId: 'x' }),
    (error: Error) => {
      assert.equal(error.message, 'Rate multiplier must not be negative.');
      return true;
    },
  );
});

test('a conversion past the 64-bit range throws MONEY.OVERFLOW from the lab', () => {
  const huge = Rate.from({ rate: 10n ** 30n, scale: 0, rateId: 'huge' });
  assert.throws(
    () => huge.convertFloor('CREDIT:20000.00', 'USD'),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'MONEY.OVERFLOW');
      return true;
    },
  );
});

test('from() hands an existing Rate straight back, since a Rate cannot change', () => {
  const rate = Rate.from(PAYOUT);
  assert.equal(Rate.from(rate), rate);
  assert.equal(createRate(rate), rate);
});

test('gte() agrees with the lab on the same inputs, across scales', () => {
  const rates = [
    PAYOUT,
    BUY,
    { rate: 1n, scale: 0, rateId: 'par' },
    { rate: 100n, scale: 2, rateId: 'par-scaled' },
    { rate: 0n, scale: 0, rateId: 'zero' },
    { rate: 500n, scale: 5, rateId: 'payout-rescaled' },
  ];
  for (const left of rates) {
    for (const right of rates) {
      assert.equal(
        Rate.from(left).gte(Rate.from(right)),
        rateGte(left, right),
        `${left.rateId} >= ${right.rateId}`,
      );
    }
  }
});

test('gte() compares the value, not the scale it is written at', () => {
  // 5/10^3 and 500/10^5 are the same rate written two ways, so each is at least the other.
  const payout = Rate.from(PAYOUT);
  const rescaled = Rate.from({
    rate: 500n,
    scale: 5,
    rateId: 'payout-rescaled',
  });
  assert.equal(payout.gte(rescaled), true);
  assert.equal(rescaled.gte(payout), true);
  // A par rate sits above the buy rate, which prices a credit well under a dollar.
  assert.equal(Rate.from({ rate: 1n, scale: 0, rateId: 'par' }).gte(BUY), true);
  assert.equal(
    Rate.from(BUY).gte({ rate: 1n, scale: 0, rateId: 'par' }),
    false,
  );
});

test('there is no door to an unnamed rate, so no door prices at one-for-one', () => {
  // A blank Rate is 1/10^0 with no id: the silent one-for-one this module exists to refuse.
  // `Rate.from(null)` throwing means nothing while the constructor hands one out for free.
  for (const build of [
    // The type pin: make the argument optional again and tsc reports this directive unused.
    // @ts-expect-error the argument is required; the call still runs, so the throw is pinned
    () => new Rate(),
    // The blank init object is the same hole spelled with an argument: it is what the readers
    // used to default into 1/10^0 with no name. Now every field is required, so each of these
    // is a compile error as well as a throw, and the directive goes unused if one turns
    // optional again.
    // @ts-expect-error every field is required; the call still runs, so the throw is pinned
    () => new Rate({}),
    // @ts-expect-error every field is required; the call still runs, so the throw is pinned
    () => createRate({}),
    // @ts-expect-error every field is required; the call still runs, so the throw is pinned
    () => Rate.from({}),
    () => new Rate({ rate: 1n, scale: 0, rateId: '' }),
    () => new Rate(''),
    () => new Rate(0 as never),
    () => new Rate(undefined as never),
    () => createRate(undefined as never),
    () => createRate(null as never),
    () => Rate.from(undefined as never),
    () => Rate.from([] as never),
    () => Rate.from(5 as never),
  ]) {
    assert.throws(
      build,
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CONFIG.INVALID');
        return true;
      },
      String(build),
    );
  }

  // 20,000 credits are $100.00 at the payout rate and $20,000.00 at one-for-one, so the value
  // of the hole is the whole conversion.
  assert.equal(
    Rate.from(PAYOUT).convertFloor('CREDIT:20000.00', 'USD').toString(),
    'USD:100.00',
  );
});
