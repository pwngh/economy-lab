# money

The typed values [`@pwngh/economy`](../economy) puts on the wire. `money` parses, compares, and
serializes them: [`Money`](#money) is an amount, [`Rate`](#rate) a CREDIT-to-USD multiplier
carrying its own `rateId`, and [`Bps`](#bps) a share out of 10,000.

## Features

- **`toString()` is the whole interface:** `WireValue` asks for nothing else, so a value
  serializes itself wherever the wire expects text — `JSON.stringify`, a template literal, a
  URL.
- **One parse, whichever door:** every constructor delegates to `from()`, so a wire string, an
  init object, and a whole number of credits all land in the same validation.
- **Integers all the way down:** the wire is a decimal string, the value is a `bigint`, and a
  share is a whole number out of 10,000. [No `number` ever holds an
  amount](#what-never-crosses-this-boundary), so no cent rounds away.
- **No arithmetic here:** parsing, rounding, conversion, fee policy, and the 64-bit range check
  all run in `@pwngh/economy-lab`. This package chooses no rounding mode of its own.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

Each value parses with `from()`, carries exact integers, and serializes itself back:

```ts
import { Money } from '@pwngh/economy/money';

let price = Money.from('CREDIT:600.00');

price.currency; // 'CREDIT'
price.minor; // 60000n
price.decimal; // '600.00'
price.toString(); // 'CREDIT:600.00'
```

```ts
let price = Money.from('CREDIT:600.00');

JSON.stringify({
  price,
}) // '{"price":"CREDIT:600.00"}'
`${price}`; // 'CREDIT:600.00'
```

If you only need one value (for example, just `Rate`), import it directly from its subpath. This avoids pulling the package barrel:

```ts
import { Rate } from '@pwngh/economy/money/rate';
import { Bps } from '@pwngh/economy/money/bps';
```

### Money

An amount as `CURRENCY:decimal`. Build one from a wire string, an init object, or a whole number of credits. The constructor delegates to `from()`, so every door lands in the same parse:

```ts
import { Money, createMoney, credits, usd } from '@pwngh/economy/money';

Money.from('CREDIT:20000.00'); // the payout minimum
Money.from({ currency: 'USD', decimal: '100.00' }); // what those credits cash out to
Money.from({ currency: 'USD', minor: 999n }); // $9.99

new Money('CREDIT:600.00');
createMoney('CREDIT:600.00');

// An absent wire field is zero credits
Money.from(null).toString(); // 'CREDIT:0.00'
new Money().toString(); // 'CREDIT:0.00'

// Absent, not falsy. Everything else that will not parse throws, including an empty string
new Money(''); // throws MONEY.INVALID_AMOUNT
Money.from(600); // throws MONEY.INVALID_AMOUNT — 600 is not a wire string or an init object
```

A `Money` is immutable, and `from()` hands an existing one straight back rather than copying it. The `amount` it exposes is frozen for the same reason: one holder cannot rewrite a value the others are reading.

`credits` and `usd` are the ledger's own amount constructors, re-exported here so there is one of each in the ecosystem. They build the branded `Amount` an operation takes; `Money.from` parses one off the wire. Different jobs, one name each:

```ts
import { Money, credits, usd } from '@pwngh/economy/money';
import { topUp } from '@pwngh/economy/ops';

let amount = credits(600); // the Amount an operation carries

topUp({ userId: 'usr_4c1d9e', amount, source: 'stripe' });

Money.from(amount).toString(); // 'CREDIT:600.00', the same value on the wire
Money.from(usd('9.99')).toString(); // 'USD:9.99'
```

An `Amount` out of the ledger is already a valid initializer, and `.amount` hands the branded value back for a leg or an operation:

```ts
let payout = Money.from(usd('100.00'));

payout.toString(); // 'USD:100.00'
payout.amount; // the branded ledger Amount, ready for the return trip
```

`add`, `subtract`, `compare`, `equals`, and `isZero` take a `Money`, an `Amount`, a wire string, or an init object alike. Every one returns a new value; a `Money` never changes:

```ts
let balance = Money.from(credits(20_000));

balance.add('CREDIT:600.00').toString(); // 'CREDIT:20600.00'
balance.subtract(credits(600)).toString(); // 'CREDIT:19400.00'
balance.compare('CREDIT:600.00'); // 1
balance.equals(credits(20_000)); // true
balance.subtract(balance).isZero(); // true

balance.toString(); // 'CREDIT:20000.00' — untouched
```

Currencies do not mix. The arithmetic and `compare` throw across them; `equals` answers `false`, because asking whether a price equals a payout is a question, not a bug:

```ts
let price = Money.from('CREDIT:600.00');

price.equals('USD:600.00'); // false
price.add('USD:600.00'); // throws LEDGER.CURRENCY_MISMATCH
```

### Rate

A CREDIT-to-USD conversion rate as exact integers: the multiplier is `rate / 10^scale`, and `rateId` names which rate priced a transaction. The wire form is the object `GET /v1/rates` sends, so a storefront parses the response body directly:

```ts
import { Rate, createRate } from '@pwngh/economy/money';

let payout = Rate.from({
  rate: '5',
  scale: 3,
  rateId: 'payout:CREDIT->USD:5/3',
});

new Rate({ rate: '5', scale: 3, rateId: 'payout:CREDIT->USD:5/3' });
createRate({ rate: '5', scale: 3, rateId: 'payout:CREDIT->USD:5/3' });

payout.rate; // 5n
payout.scale; // 3
payout.rateId; // 'payout:CREDIT->USD:5/3'
payout.toString(); // '{"rate":"5","scale":3,"rateId":"payout:CREDIT->USD:5/3"}'
```

The `rateId` is minted by the ledger's rates port and recorded on the transaction it priced. It travels through this package byte for byte; nothing here parses or rebuilds one.

Each conversion names its own direction, because the safe way to round depends on who the remainder belongs to. A payout floors, so the sub-cent stays with the platform instead of being minted. The trust side ceils, so it never under-covers what it backs:

```ts
// $0.005 per credit: 20,000 credits is the payout minimum
payout.convertFloor('CREDIT:20000.00', 'USD'); // Money USD:100.00

// 20,001 credits is $100.005 exactly, and the two directions must disagree
payout.convertFloor('CREDIT:20001.00', 'USD'); // Money USD:100.00
payout.convertCeil('CREDIT:20001.00', 'USD'); // Money USD:100.01
```

A `Rate` instance satisfies the ledger's own `Rate` type, so any lab function that takes one takes this, with no unwrapping step.

`gte()` compares two rates by cross-multiplying, so two spellings of one rate compare equal and no division rounds the answer. It is the check the ledger itself makes before it prices at a quoted rate:

```ts
let par = Rate.from({ rate: '1', scale: 0, rateId: 'par' });
let rescaled = Rate.from({ rate: '500', scale: 5, rateId: 'payout-rescaled' });

payout.gte(rescaled); // true — 5/10^3 and 500/10^5 are one rate written two ways
rescaled.gte(payout); // true
par.gte(payout); // true — a credit is priced well under a dollar
payout.gte(par); // false
```

Unlike an amount, a rate has no safe empty value. Applying a missing one would price a storefront at one-for-one in silence, so `Rate.from(null)` throws where `Money.from(null)` returns zero credits.

There is no blank rate to construct either. All three fields are required, so `new Rate()` and an init object short a field are both compile errors: a rate with no multiplier and no scale would be the 1/10^0 that turns 20,000 credits into $20,000.00 instead of $100.00. The same body decoded from JSON never met the compiler, so it throws, field by field. A dropped `scale` is the one worth naming — read as 0 it prices at the multiplier raw, which is further off than one-for-one:

```ts
Rate.from('{"rate":"5","rateId":"payout:CREDIT->USD:5/3"}');
// CONFIG.INVALID: A rate must carry the scale its multiplier divides by; there is no default scale.

let raw = createRate({ rate: '5', scale: 0, rateId: 'raw:CREDIT->USD:5/0' });

raw.convertFloor('CREDIT:20000.00', 'USD'); // Money USD:100000.00
payout.convertFloor('CREDIT:20000.00', 'USD'); // Money USD:100.00
```

### Bps

A share in basis points: 100 bps is one percent, 10,000 bps is the whole. Recipient shares and the platform fee rate are both spelled in these units, and the wire carries them as plain integers:

```ts
import { Bps, bps, createBps } from '@pwngh/economy/money';

let fee = bps(1_530); // the default platform fee rate

fee.bps; // 1530
fee.toString(); // '1530'
Bps.WHOLE; // 10000

JSON.stringify({ sellerId: 'usr_seller', shareBps: bps(10_000) });
// '{"sellerId":"usr_seller","shareBps":10000}'
```

`share()` takes a share of an amount, rounded down — the same exact multiply and the same floor the ledger applies when it divides a sale among sellers:

```ts
bps(3_000).share('CREDIT:1000.00'); // Money CREDIT:300.00
bps(3_333).share('CREDIT:999.99'); // Money CREDIT:333.29
```

Shares on a sale must add up to the whole, and a set that does not fails where it was built rather than after it crossed the wire:

```ts
Bps.assertShareSum([bps(5_000), bps(2_500), bps(2_500)]); // fine
Bps.assertShareSum([]); // fine: with no one to pay, the net goes to revenue
Bps.assertShareSum([bps(5_000), bps(4_999)]); // throws OP.MALFORMED
```

Rounding each share down leaves a residual on a net that does not divide evenly. The ledger credits that residual to platform revenue, so no minor unit of a sale is lost:

```ts
let net = Money.from('CREDIT:999.99');
let shares = [bps(3_333), bps(3_333), bps(3_334)];

let paid = shares.reduce(
  (total, share) => total.add(share.share(net)),
  Money.from(null),
);

paid.toString(); // 'CREDIT:999.97'
net.subtract(paid).toString(); // 'CREDIT:0.02' — what revenue keeps
```

`fee()` is the platform fee on a price, exactly as the ledger charges it. The fee comes off the top, rounds up to a whole credit, and is capped at the price, so a fee quoted before a sale is the fee the posting takes:

```ts
bps(1_530).fee('CREDIT:1000.00'); // Money CREDIT:153.00
bps(1_530).fee('CREDIT:1000.50'); // Money CREDIT:154.00 — up to the whole credit
bps(1_530).fee('CREDIT:0.50'); // Money CREDIT:0.50 — a fee never exceeds the price
```

Rounding up to a whole credit is a rule about credits, so `fee()` and `revenue()` take CREDIT and refuse any other currency with `OP.MALFORMED`. `share()` takes any currency — a fraction rounded down needs no whole unit:

```ts
bps(1_530).fee('USD:1.07'); // throws OP.MALFORMED
bps(1_530).share('USD:100.00'); // Money USD:15.30
```

`revenue()` is what the platform actually keeps on a split: the fee plus the residual above. It is the figure the ledger records as the sale's fee, which on an uneven split is more than `fee()` alone:

```ts
let price = Money.from('CREDIT:999.99');
let shares = [bps(3_333), bps(3_333), bps(3_334)];

bps(1_530).fee(price).toString(); // 'CREDIT:153.00'
bps(1_530).revenue(price, shares).toString(); // 'CREDIT:153.01' — the fee plus one unit over
bps(1_530)
  .revenue(price, [bps(10_000)])
  .toString(); // 'CREDIT:153.00' — nothing left over
```

### Errors

Malformed input throws. A wire value here is written by this system, not typed by a client, so one that will not parse means code upstream built it wrong — returning `null` would carry that bug forward into whatever reads the money next. Every failure is the ledger's own `EconomyError`, under the code the ledger already uses for that kind of fault:

```ts
Money.from('EUR:1.00'); // MONEY.INVALID_AMOUNT: Not an encoded amount: EUR:1.00.
Money.from('600.00'); // MONEY.INVALID_AMOUNT: Not an encoded amount: 600.00.
Money.from('CREDIT:1.005'); // MONEY.INVALID_AMOUNT: Not a 2-decimal money string: 1.005.
Money.from('CREDIT:1,000.00'); // MONEY.INVALID_AMOUNT: Not a 2-decimal money string: 1,000.00.

Rate.from(null); // CONFIG.INVALID: A rate must be named; there is no default rate.
Rate.from('{"rate":"5","scale":3}'); // CONFIG.INVALID: A rate must carry the rateId ...

Bps.from(10_001); // OP.MALFORMED: Basis points must be a whole number from 0 to 10000.
```

The init fields are checked at run time as well as by the compiler, because the body this package parses arrives decoded from JSON with no types left on it:

```ts
Money.from({ minor: 1 }); // MONEY.INVALID_AMOUNT: Money minor units must be a bigint, not a number ...
Money.from({ decimal: 5 }); // MONEY.INVALID_AMOUNT: Money decimal must be a two-place decimal string ...
Rate.from('{"rate":5,"scale":3,"rateId":"x"}'); // CONFIG.INVALID: Rate multiplier must be a bigint or a string of digits ...
```

### What never crosses this boundary

No float. The wire is a decimal string, the value is a `bigint`, and shares are integers that must sum to 10,000. Nothing here is ever a `number` that could round a cent away:

```ts
let big = Money.from({ currency: 'CREDIT', minor: 9_007_199_254_740_993n });

big.minor; // 9007199254740993n — the first integer a double cannot name
big.toString(); // 'CREDIT:90071992547409.93'
Number(big.decimal); // 90071992547409.94 — what a float would have made of it
```

No arithmetic either. Parsing, rounding, currency conversion, fee policy, rate comparison, and the 64-bit range check all run in `@pwngh/economy-lab`: `toAmount`, `decodeAmountWire`, `encodeAmount`, `add`, `negate`, `compare`, `isZero`, `convertFloor`, `convertCeil`, `feeForPrice`, `revenueForSplit`, and `rateGte`. This package chooses no rounding mode of its own, and its tests assert the results against those same functions on the same inputs.

The fee is the case that matters most. Its whole-credit rounding and its price cap live in the ledger's fee policy, so `fee()` and `revenue()` call that policy rather than restating it — a helper that disagreed with the posted fee would be worse than no helper at all.

## Related Packages

- [`@pwngh/economy-lab`](https://github.com/pwngh/economy-lab) - The ledger that owns the arithmetic, the `Amount` brand, and the currency table
- [`@pwngh/economy`](https://github.com/pwngh/economy-lab/tree/main/packages/economy) - One install for every package here, and the `economy` command

## License

See [LICENSE.md](https://github.com/pwngh/economy-lab/blob/main/LICENSE.md)
