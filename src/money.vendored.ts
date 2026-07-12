/**
 * @pwngh/money
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

/**
 * Minor-unit integer money, as a single-file amalgamation. Zero imports, erasable syntax
 * only, so this one file composes into any environment unchanged: run directly under
 * Node >= 22.18 type stripping, vendor into a repo (economy-lab keeps zero runtime
 * dependencies by copying this file, not depending on it), publish as-is to npm, or feed
 * to any bundler. Reimplementations in other languages (UdonSharp) do not consume this
 * code; they consume `vectors`, the embedded conformance suite that pins every carrier
 * of these semantics to identical behavior. Drift across copies is a test failure, not
 * a discipline problem.
 *
 * Extract the vectors for a non-TypeScript runner:
 *
 *   node -e 'import("./money.ts").then(m => console.log(JSON.stringify(m.vectors)))' > vectors.json
 *
 * Amounts are `bigint` minor units checked into i64 range, so totals stay exact past
 * Number precision and line up with Postgres `bigint` and C# `long`. Arithmetic throws
 * on broken premises (overflow, currency mismatch, invalid weights, bad rates); `parse` and
 * `decode` are the untrusted boundaries and return null for every "no". No Intl, no locale tables:
 * formatting is manual grouping, identical on every runtime.
 */

/** A money value. Structurally beneath economy-lab's branded Amount: lab's toAmount adds the brand, arithmetic here is shared. */
export interface Amount {
  readonly currency: string;
  readonly minor: bigint;
}

export const I64_MIN = -(2n ** 63n);
export const I64_MAX = 2n ** 63n - 1n;

/** The ISO 4217 List One amendment this exponent table is current through. */
export const ISO_4217_AMENDMENT = 180;

/**
 * Every ISO 4217 List One currency whose minor-unit exponent is not 2, current through
 * Amendment 180 (2025-09-22, effective 2026-01-01). Unlisted codes — the exponent-2
 * majority, private codes like CREDIT, and the non-currency codes ISO marks N.A. —
 * resolve to 2 by stated policy rather than per-call-site guessing.
 */
// prettier-ignore
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

/** Minor-unit exponent for a currency code: minor = whole * 10^exponent. */
export function exponent(currency: string): number {
  return EXPONENTS[currency] ?? 2;
}

function checkI64(minor: bigint): bigint {
  if (minor < I64_MIN || minor > I64_MAX) {
    throw new RangeError('i64 overflow');
  }
  return minor;
}

function assertSameCurrency(a: Amount, b: Amount): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

/** Builds a range-checked Amount from a currency and a minor-unit count. */
export function amount(currency: string, minor: bigint): Amount {
  return { currency, minor: checkI64(minor) };
}

export function isZero(a: Amount): boolean {
  return a.minor === 0n;
}

export function isNegative(a: Amount): boolean {
  return a.minor < 0n;
}

/** Adds two amounts of the same currency. Throws on mismatch or i64 overflow. */
export function add(a: Amount, b: Amount): Amount {
  assertSameCurrency(a, b);
  return amount(a.currency, a.minor + b.minor);
}

/** Subtracts b from a in the same currency. Throws on mismatch or i64 overflow. */
export function sub(a: Amount, b: Amount): Amount {
  assertSameCurrency(a, b);
  return amount(a.currency, a.minor - b.minor);
}

export function neg(a: Amount): Amount {
  return amount(a.currency, -a.minor);
}

export function abs(a: Amount): Amount {
  return a.minor < 0n ? neg(a) : a;
}

/** Scales an amount by an integer factor. Throws on i64 overflow. */
export function mul(a: Amount, k: bigint): Amount {
  return amount(a.currency, a.minor * k);
}

/** Compares two amounts of the same currency. Throws on mismatch. */
export function compare(a: Amount, b: Amount): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

/**
 * Rounding modes for division. halfEven is banker's rounding, ties to the even
 * quotient, carrying no directional bias under repetition; halfUp is ties away from
 * zero, the statutory rounding of tax and VAT rules.
 */
export type Rounding = 'floor' | 'ceil' | 'trunc' | 'halfEven' | 'halfUp';

/**
 * Integer division with the rounding mode named at the call site, because BigInt, C#,
 * and SQL disagree on negative quotients (-7/2 is -4 floored, -3 truncated) and a mode
 * left implicit is a mode chosen by the host language. Operands are unbounded bigints;
 * the result is checked into i64. Zero divisor and unknown mode are broken premises
 * and throw.
 */
export function divRound(num: bigint, den: bigint, mode: Rounding): bigint {
  if (den === 0n) throw new TypeError('divRound: zero divisor');
  const q = num / den;
  const r = num % den;
  if (r === 0n) return checkI64(q);
  const negative = num < 0n !== den < 0n;
  if (mode === 'trunc') return checkI64(q);
  if (mode === 'floor') return checkI64(negative ? q - 1n : q);
  if (mode === 'ceil') return checkI64(negative ? q : q + 1n);
  if (mode === 'halfEven' || mode === 'halfUp') {
    const twice = 2n * (r < 0n ? -r : r);
    const magnitude = den < 0n ? -den : den;
    const step = negative ? -1n : 1n;
    if (twice < magnitude) return checkI64(q);
    if (twice > magnitude) return checkI64(q + step);
    if (mode === 'halfUp') return checkI64(q + step);
    return checkI64(q % 2n === 0n ? q : q + step);
  }
  throw new TypeError(`divRound: unknown mode ${String(mode)}`);
}

/**
 * value * num / den through an arbitrary-precision intermediate, then divRound: the
 * rate, fee, and conversion primitive. The intermediate deliberately exceeds i64 —
 * vectors near I64_MAX exist to force other carriers into 128-bit arithmetic — and
 * only the result is range-checked.
 */
export function mulDiv(value: bigint, num: bigint, den: bigint, mode: Rounding): bigint {
  return divRound(value * num, den, mode);
}

/**
 * A conversion rate as an exact rational: num / den units of the target per whole unit
 * of the source. Never a float.
 */
export interface Rate {
  readonly num: bigint;
  readonly den: bigint;
}

/**
 * Converts an amount across currencies through a rational rate with the
 * 10^(expTo − expFrom) rescale built in, because the cross-exponent step is where
 * hand-rolled conversions rot: USD cents to JPY yen is not a bare multiply. The
 * rounding mode is named at the call site; a non-positive denominator or negative
 * numerator is a broken premise and throws. The result is a range-checked Amount.
 */
export function convert(a: Amount, to: string, r: Rate, mode: Rounding): Amount {
  if (r.den <= 0n) throw new TypeError('convert: non-positive rate denominator');
  if (r.num < 0n) throw new TypeError('convert: negative rate numerator');
  const scaleTo = 10n ** BigInt(exponent(to));
  const scaleFrom = 10n ** BigInt(exponent(a.currency));
  return amount(to, divRound(a.minor * r.num * scaleTo, r.den * scaleFrom, mode));
}

const WIRE = /^([A-Z]{3,12}):(0|-?[1-9][0-9]*)$/;

/**
 * Canonical wire form, `CUR:minor`, exactly one encoding per value so equality is byte
 * equality and reconciliation compares strings. Encoding a malformed currency or an
 * out-of-range minor is a broken premise and throws: the caller built that Amount.
 */
export function encode(a: Amount): string {
  if (!/^[A-Z]{3,12}$/.test(a.currency)) {
    throw new TypeError(`encode: bad currency ${a.currency}`);
  }
  return `${a.currency}:${checkI64(a.minor)}`;
}

/**
 * The untrusted boundary for wire text: strict grammar, canonical integers only (no
 * leading zeros, no -0), i64 range enforced, null for every "no" — so decode∘encode
 * and encode∘decode are both identities on the valid domain.
 */
export function decode(text: string): Amount | null {
  const match = WIRE.exec(text);
  if (match === null) return null;
  const [, currency, digits] = match;
  const minor = BigInt(digits);
  if (minor < I64_MIN || minor > I64_MAX) return null;
  return { currency, minor };
}

/**
 * Formats minor units as a plain decimal string with 3-digit grouping. Locale-free by
 * design: the same bytes on Node, browsers, and the UdonSharp reimplementation. The
 * separator options are pinned by vectors because consumers build their decimal wire
 * from them: economy-edge's and economy-lab's `USD:12.34` is `format` with group ''.
 */
export function format(
  minor: bigint,
  exp: number,
  options?: { group?: string; decimal?: string },
): string {
  const group = options?.group ?? ',';
  const decimal = options?.decimal ?? '.';
  const sign = minor < 0n ? '-' : '';
  const digits = (minor < 0n ? -minor : minor).toString().padStart(exp + 1, '0');
  const whole = exp === 0 ? digits : digits.slice(0, -exp);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return exp === 0 ? sign + grouped : sign + grouped + decimal + digits.slice(-exp);
}

/**
 * Parses a decimal string to minor units. The untrusted boundary: every rejection is
 * null, never a throw. Accepts an optional leading minus, digits either ungrouped or
 * correctly comma-grouped, and at most `exp` fraction digits (shorter pads, longer is
 * rejected rather than silently truncated). Out-of-i64-range values are rejected.
 */
export function parse(text: string, exp: number): bigint | null {
  const match = /^(-?)(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/.exec(text);
  if (match === null) return null;
  const [, sign, wholeRaw, fraction] = match;
  if (fraction !== undefined && (exp === 0 || fraction.length > exp)) return null;
  const whole = wholeRaw.replaceAll(',', '');
  const scaled = BigInt(whole + (fraction ?? '').padEnd(exp, '0'));
  const minor = sign === '-' ? -scaled : scaled;
  return minor < I64_MIN || minor > I64_MAX ? null : minor;
}

/**
 * Splits minor units across integer weights with no lost unit: shares sum to `minor`
 * exactly. Floor division first, then the remainder goes one unit at a time to the
 * largest fractional parts (ties to the lower index), so the result is deterministic.
 * Negative amounts allocate as the negated allocation of their absolute value.
 */
export function allocate(minor: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new TypeError('allocate: no weights');
  let total = 0n;
  for (const w of weights) {
    if (w < 0n) throw new TypeError('allocate: negative weight');
    total += w;
  }
  if (total === 0n) throw new TypeError('allocate: zero total weight');
  if (minor < 0n) return allocate(-minor, weights).map((s) => -s);
  const shares = weights.map((w) => (minor * w) / total);
  let remainder = minor - shares.reduce((sum, s) => sum + s, 0n);
  const order = weights
    .map((w, i) => ({ i, frac: (minor * w) % total }))
    .sort((a, b) => (a.frac === b.frac ? a.i - b.i : b.frac > a.frac ? 1 : -1));
  for (const { i } of order) {
    if (remainder === 0n) break;
    shares[i] += 1n;
    remainder -= 1n;
  }
  return shares;
}

/**
 * Splits minor units by basis points, floor per share, remainder to the caller: the
 * economy-lab Recipient contract, where the platform keeps the remaining fee. Unlike
 * `allocate`, the remainder is a return value, not redistributed.
 */
export function splitBps(
  minor: bigint,
  bps: readonly number[],
): { shares: bigint[]; remainder: bigint } {
  let totalBps = 0;
  for (const share of bps) {
    if (!Number.isInteger(share) || share < 0) throw new TypeError('splitBps: bad bps');
    totalBps += share;
  }
  if (totalBps > 10_000) throw new TypeError('splitBps: bps exceed 10000');
  const shares = bps.map((share) => (minor * BigInt(share)) / 10_000n);
  const remainder = minor - shares.reduce((sum, s) => sum + s, 0n);
  return { shares, remainder };
}

/**
 * The conformance suite, embedded so the file is its own single source of truth.
 * JSON-safe (bigints carried as strings) so non-TypeScript runners consume the same
 * vectors byte for byte. 'throws' marks calls whose premise is invalid.
 */
export type Vector =
  | readonly ['exp', string, number]
  | readonly ['parse', string, number, string | null]
  | readonly ['format', string, number, string, (readonly [string, string])?]
  | readonly ['add', string, string, string | 'throws']
  | readonly ['mul', string, string, string | 'throws']
  | readonly ['div', string, string, Rounding, string | 'throws']
  | readonly ['muldiv', string, string, string, Rounding, string | 'throws']
  | readonly ['conv', string, string, string, string, string, Rounding, string | 'throws']
  | readonly ['enc', string, string, string | 'throws']
  | readonly ['dec', string, string | null]
  | readonly ['alloc', string, readonly string[], readonly string[] | 'throws']
  | readonly ['bps', string, readonly number[], readonly string[], string];

export const vectors: readonly Vector[] = [
  ['exp', 'USD', 2],
  ['exp', 'CREDIT', 2],
  ['exp', 'XYZ', 2],
  ['exp', 'BIF', 0],
  ['exp', 'CLP', 0],
  ['exp', 'DJF', 0],
  ['exp', 'GNF', 0],
  ['exp', 'ISK', 0],
  ['exp', 'JPY', 0],
  ['exp', 'KMF', 0],
  ['exp', 'KRW', 0],
  ['exp', 'PYG', 0],
  ['exp', 'RWF', 0],
  ['exp', 'UGX', 0],
  ['exp', 'UYI', 0],
  ['exp', 'VND', 0],
  ['exp', 'VUV', 0],
  ['exp', 'XAF', 0],
  ['exp', 'XOF', 0],
  ['exp', 'XPF', 0],
  ['exp', 'BHD', 3],
  ['exp', 'IQD', 3],
  ['exp', 'JOD', 3],
  ['exp', 'KWD', 3],
  ['exp', 'LYD', 3],
  ['exp', 'OMR', 3],
  ['exp', 'TND', 3],
  ['exp', 'CLF', 4],
  ['exp', 'UYW', 4],

  ['parse', '0', 2, '0'],
  ['parse', '0.00', 2, '0'],
  ['parse', '1', 2, '100'],
  ['parse', '1.5', 2, '150'],
  ['parse', '1.50', 2, '150'],
  ['parse', '-0.05', 2, '-5'],
  ['parse', '-0', 2, '0'],
  ['parse', '1234.56', 2, '123456'],
  ['parse', '1,234.56', 2, '123456'],
  ['parse', '1,234,567.89', 2, '123456789'],
  ['parse', '007', 2, '700'],
  ['parse', '1,500', 0, '1500'],
  ['parse', '1.234', 3, '1234'],
  ['parse', '92233720368547758.07', 2, '9223372036854775807'],
  ['parse', '-92233720368547758.08', 2, '-9223372036854775808'],
  ['parse', '92233720368547758.08', 2, null],
  ['parse', '', 2, null],
  ['parse', '.', 2, null],
  ['parse', '.5', 2, null],
  ['parse', '1.', 2, null],
  ['parse', '+5', 2, null],
  ['parse', '-', 2, null],
  ['parse', '1.234', 2, null],
  ['parse', '1.5', 0, null],
  ['parse', '12,34.56', 2, null],
  ['parse', '1,2345', 2, null],
  ['parse', ',123', 2, null],
  ['parse', '1 234', 2, null],
  ['parse', '1e2', 2, null],
  ['parse', '0x10', 2, null],

  ['format', '0', 2, '0.00'],
  ['format', '5', 2, '0.05'],
  ['format', '-5', 2, '-0.05'],
  ['format', '150', 2, '1.50'],
  ['format', '123456', 2, '1,234.56'],
  ['format', '123456789', 2, '1,234,567.89'],
  ['format', '-123456789', 2, '-1,234,567.89'],
  ['format', '1500', 0, '1,500'],
  ['format', '1234', 3, '1.234'],
  ['format', '9223372036854775807', 2, '92,233,720,368,547,758.07'],
  ['format', '123456', 2, '1234.56', ['', '.']],
  ['format', '-123456789', 2, '-1234567.89', ['', '.']],
  ['format', '1500', 0, '1500', ['', '.']],
  ['format', '123456', 2, '1.234,56', ['.', ',']],

  ['add', '9223372036854775807', '0', '9223372036854775807'],
  ['add', '9223372036854775807', '1', 'throws'],
  ['add', '-9223372036854775808', '-1', 'throws'],
  ['add', '20', '22', '42'],
  ['mul', '4611686018427387903', '2', '9223372036854775806'],
  ['mul', '4611686018427387904', '2', 'throws'],
  ['mul', '-5', '3', '-15'],

  ['div', '7', '2', 'floor', '3'],
  ['div', '7', '2', 'ceil', '4'],
  ['div', '7', '2', 'trunc', '3'],
  ['div', '7', '2', 'halfEven', '4'],
  ['div', '-7', '2', 'floor', '-4'],
  ['div', '-7', '2', 'ceil', '-3'],
  ['div', '-7', '2', 'trunc', '-3'],
  ['div', '-7', '2', 'halfEven', '-4'],
  ['div', '7', '-2', 'floor', '-4'],
  ['div', '7', '-2', 'ceil', '-3'],
  ['div', '7', '-2', 'trunc', '-3'],
  ['div', '7', '-2', 'halfEven', '-4'],
  ['div', '-7', '-2', 'floor', '3'],
  ['div', '-7', '-2', 'ceil', '4'],
  ['div', '-7', '-2', 'trunc', '3'],
  ['div', '-7', '-2', 'halfEven', '4'],
  ['div', '5', '2', 'halfEven', '2'],
  ['div', '3', '2', 'halfEven', '2'],
  ['div', '-5', '2', 'halfEven', '-2'],
  ['div', '-3', '2', 'halfEven', '-2'],
  ['div', '1', '2', 'halfEven', '0'],
  ['div', '-1', '2', 'halfEven', '0'],
  ['div', '8', '3', 'halfEven', '3'],
  ['div', '7', '3', 'halfEven', '2'],
  ['div', '-8', '3', 'halfEven', '-3'],
  ['div', '6', '3', 'floor', '2'],
  ['div', '-6', '3', 'ceil', '-2'],
  ['div', '0', '5', 'halfEven', '0'],
  ['div', '5', '0', 'floor', 'throws'],
  ['div', '-9223372036854775808', '-1', 'trunc', 'throws'],
  ['div', '9223372036854775807', '1', 'ceil', '9223372036854775807'],
  ['div', '7', '2', 'halfUp', '4'],
  ['div', '-7', '2', 'halfUp', '-4'],
  ['div', '7', '-2', 'halfUp', '-4'],
  ['div', '-7', '-2', 'halfUp', '4'],
  ['div', '5', '2', 'halfUp', '3'],
  ['div', '-5', '2', 'halfUp', '-3'],
  ['div', '1', '2', 'halfUp', '1'],
  ['div', '-1', '2', 'halfUp', '-1'],
  ['div', '7', '3', 'halfUp', '2'],

  ['muldiv', '9223372036854775807', '10000', '10000', 'floor', '9223372036854775807'],
  ['muldiv', '12345', '250', '10000', 'floor', '308'],
  ['muldiv', '12345', '250', '10000', 'ceil', '309'],
  ['muldiv', '12345', '250', '10000', 'halfEven', '309'],
  ['muldiv', '-12345', '250', '10000', 'floor', '-309'],
  ['muldiv', '-12345', '250', '10000', 'trunc', '-308'],
  ['muldiv', '25', '1', '2', 'halfEven', '12'],
  ['muldiv', '25', '1', '2', 'halfUp', '13'],
  ['muldiv', '15', '1', '2', 'halfEven', '8'],
  ['muldiv', '1050', '1000000', '851234', 'floor', '1233'],
  ['muldiv', '1050', '1000000', '851234', 'halfEven', '1234'],
  ['muldiv', '9223372036854775807', '2', '1', 'floor', 'throws'],

  ['conv', 'USD', '1050', 'JPY', '15123', '100', 'floor', '1587'],
  ['conv', 'USD', '1050', 'JPY', '15123', '100', 'halfUp', '1588'],
  ['conv', 'JPY', '1000', 'USD', '100', '15123', 'halfEven', '661'],
  ['conv', 'USD', '10000', 'BHD', '376', '1000', 'trunc', '37600'],
  ['conv', 'CLF', '12345', 'USD', '1', '1', 'halfEven', '123'],
  ['conv', 'CLF', '12250', 'USD', '1', '1', 'halfEven', '122'],
  ['conv', 'CLF', '12250', 'USD', '1', '1', 'halfUp', '123'],
  ['conv', 'CLF', '12350', 'USD', '1', '1', 'halfEven', '124'],
  ['conv', 'USD', '100', 'EUR', '-1', '1', 'floor', 'throws'],
  ['conv', 'USD', '100', 'EUR', '1', '0', 'floor', 'throws'],
  ['conv', 'JPY', '9223372036854775807', 'BHD', '1000', '1', 'floor', 'throws'],

  ['enc', 'USD', '1234', 'USD:1234'],
  ['enc', 'CREDIT', '-5', 'CREDIT:-5'],
  ['enc', 'USD', '9223372036854775807', 'USD:9223372036854775807'],
  ['enc', 'usd', '5', 'throws'],
  ['enc', 'USD', '9223372036854775808', 'throws'],

  ['dec', 'USD:1234', 'USD:1234'],
  ['dec', 'CREDIT:-5', 'CREDIT:-5'],
  ['dec', 'USD:0', 'USD:0'],
  ['dec', 'USD:-0', null],
  ['dec', 'USD:007', null],
  ['dec', 'usd:5', null],
  ['dec', 'USD:', null],
  ['dec', 'USD:1.5', null],
  ['dec', 'USD:9223372036854775808', null],

  ['alloc', '100', ['1', '1', '1'], ['34', '33', '33']],
  ['alloc', '101', ['3', '1'], ['76', '25']],
  ['alloc', '-100', ['1', '1', '1'], ['-34', '-33', '-33']],
  ['alloc', '0', ['1', '2'], ['0', '0']],
  ['alloc', '7', ['0', '1'], ['0', '7']],
  ['alloc', '5', ['1', '1', '1', '1', '1', '1'], ['1', '1', '1', '1', '1', '0']],
  ['alloc', '100', [], 'throws'],
  ['alloc', '100', ['0', '0'], 'throws'],
  ['alloc', '100', ['-1', '2'], 'throws'],

  ['bps', '101', [5000, 5000], ['50', '50'], '1'],
  ['bps', '100', [10000], ['100'], '0'],
  ['bps', '100', [2500, 2500], ['25', '25'], '50'],
  ['bps', '-101', [5000, 5000], ['-50', '-50'], '-1'],
  ['bps', '99', [], [], '99'],
];

function throws(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch {
    return true;
  }
}

/**
 * Runs every vector against this implementation and returns the failures, empty when
 * conformant. Pure and dependency-free so any consumer, in any runtime, can assert
 * `selfTest().length === 0` without a test framework.
 */
export function selfTest(): string[] {
  const failures: string[] = [];
  const fail = (v: Vector, got: unknown): void => {
    failures.push(`${JSON.stringify(v)} got ${String(got)}`);
  };
  for (const v of vectors) {
    if (v[0] === 'exp') {
      if (exponent(v[1]) !== v[2]) fail(v, exponent(v[1]));
    } else if (v[0] === 'parse') {
      const got = parse(v[1], v[2]);
      const want = v[3] === null ? null : BigInt(v[3]);
      if (got !== want) fail(v, got);
    } else if (v[0] === 'format') {
      const options = v[4] === undefined ? undefined : { group: v[4][0], decimal: v[4][1] };
      const got = format(BigInt(v[1]), v[2], options);
      if (got !== v[3]) fail(v, got);
    } else if (v[0] === 'add' || v[0] === 'mul') {
      const a = { currency: 'USD', minor: BigInt(v[1]) };
      const run =
        v[0] === 'add'
          ? () => add(a, { currency: 'USD', minor: BigInt(v[2]) }).minor
          : () => mul(a, BigInt(v[2])).minor;
      if (v[3] === 'throws') {
        if (!throws(run)) fail(v, 'no throw');
      } else if (throws(run) || run() !== BigInt(v[3])) {
        fail(v, throws(run) ? 'throw' : run());
      }
    } else if (v[0] === 'conv') {
      const run = (): bigint =>
        convert(
          { currency: v[1], minor: BigInt(v[2]) },
          v[3],
          { num: BigInt(v[4]), den: BigInt(v[5]) },
          v[6],
        ).minor;
      if (v[7] === 'throws') {
        if (!throws(run)) fail(v, 'no throw');
      } else if (throws(run)) {
        fail(v, 'throw');
      } else if (run() !== BigInt(v[7])) {
        fail(v, run());
      }
    } else if (v[0] === 'enc') {
      const run = (): string => encode({ currency: v[1], minor: BigInt(v[2]) });
      if (v[3] === 'throws') {
        if (!throws(run)) fail(v, 'no throw');
      } else if (throws(run)) {
        fail(v, 'throw');
      } else if (run() !== v[3]) {
        fail(v, run());
      }
    } else if (v[0] === 'dec') {
      const got = decode(v[1]);
      const canonical = got === null ? null : encode(got);
      if (canonical !== v[2]) fail(v, canonical);
    } else if (v[0] === 'alloc') {
      const run = (): bigint[] => allocate(BigInt(v[1]), v[2].map(BigInt));
      if (v[3] === 'throws') {
        if (!throws(run)) fail(v, 'no throw');
      } else if (throws(run)) {
        fail(v, 'throw');
      } else {
        const got = run();
        const want = v[3].map(BigInt);
        const sum = got.reduce((s, x) => s + x, 0n);
        if (got.length !== want.length || got.some((x, i) => x !== want[i])) fail(v, got);
        else if (sum !== BigInt(v[1])) fail(v, `sum ${sum}`);
      }
    } else if (v[0] === 'div' || v[0] === 'muldiv') {
      const run =
        v[0] === 'div'
          ? () => divRound(BigInt(v[1]), BigInt(v[2]), v[3])
          : () => mulDiv(BigInt(v[1]), BigInt(v[2]), BigInt(v[3]), v[4]);
      const want = v[0] === 'div' ? v[4] : v[5];
      if (want === 'throws') {
        if (!throws(run)) fail(v, 'no throw');
      } else if (throws(run)) {
        fail(v, 'throw');
      } else if (run() !== BigInt(want)) {
        fail(v, run());
      }
    } else {
      const got = splitBps(BigInt(v[1]), v[2]);
      const want = v[3].map(BigInt);
      const ok =
        got.shares.length === want.length &&
        got.shares.every((x, i) => x === want[i]) &&
        got.remainder === BigInt(v[4]) &&
        got.shares.reduce((s, x) => s + x, 0n) + got.remainder === BigInt(v[1]);
      if (!ok) fail(v, `${got.shares} r ${got.remainder}`);
    }
  }
  return failures;
}

/**
 * Seeded property prover beside the example vectors: selfTest pins points, prove checks
 * laws over 500 sampled inputs per pass — parse∘format identity across all exponents,
 * wire round-trip, allocation and splitBps conservation, and for every rounding mode
 * both the remainder bound |num − result·den| < |den| and the floor ≤ mode ≤ ceil
 * ordering. The LCG is fixed-seed, so any failure is a reproducible counterexample,
 * never a flake.
 */
export function prove(): string[] {
  const failures: string[] = [];
  let seed = 6364136223846793005n;
  const next = (): bigint => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return BigInt.asIntN(64, seed);
  };
  const modes: readonly Rounding[] = ['floor', 'ceil', 'trunc', 'halfEven', 'halfUp'];
  const exponents = [0, 2, 3, 4] as const;
  for (let i = 0; i < 500; i += 1) {
    const minor = i % 3 === 0 ? next() : next() >> 20n;
    const exp = exponents[i % 4];
    if (parse(format(minor, exp), exp) !== minor) {
      failures.push(`parse∘format ${minor} exp ${exp}`);
    }
    const back = decode(encode({ currency: 'USD', minor }));
    if (back === null || back.minor !== minor || back.currency !== 'USD') {
      failures.push(`wire ${minor}`);
    }
    const small = next() >> 20n;
    const weights = [1n + (next() & 1023n), next() & 1023n, 1n + (next() & 1023n)];
    const shares = allocate(small, weights);
    if (shares.reduce((sum, share) => sum + share, 0n) !== small) {
      failures.push(`allocate ${small}`);
    }
    const split = splitBps(small, [1234, 4321]);
    if (split.shares[0] + split.shares[1] + split.remainder !== small) {
      failures.push(`splitBps ${small}`);
    }
    const num = next() >> 8n;
    const den = (next() >> 40n) | 1n;
    const results = modes.map((mode) => divRound(num, den, mode));
    const floorValue = results[0];
    const ceilValue = results[1];
    const magnitude = den < 0n ? -den : den;
    for (let m = 0; m < modes.length; m += 1) {
      const value = results[m];
      if (value < floorValue || value > ceilValue) {
        failures.push(`ordering ${num}/${den} ${modes[m]}`);
      }
      const remainder = num - value * den;
      if (remainder >= magnitude || remainder <= -magnitude) {
        failures.push(`remainder ${num}/${den} ${modes[m]}`);
      }
    }
  }
  return failures;
}
