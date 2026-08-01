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

/**
 * The pin behind the copies `test/dedupe.test.ts` admits.
 *
 * `packages/receipt` declares no dependencies at all, and its own test asserts that against the
 * manifest and the README, so it structurally cannot import the lab. Its base64url and hex
 * encoders therefore stay, and so does its own spelling of the lab's wire-amount rule — and a
 * copy that nothing holds against its original is a copy that drifts. Both did: the receipt
 * decoder accepted spellings the lab's refused, so one receipt had unboundedly many forms that
 * all verified, and the amount grammar accepted any uppercase currency at any magnitude, so a
 * receipt could attest to money no posting could carry.
 *
 * So the copies are driven side by side over the same inputs, outputs and refusals both. This is
 * what the admission in the dedupe gate is worth.
 *
 * What is copied is internal to the package on purpose. The codecs are reached by file, the
 * shape `packages/test/test/dev-grammar.test.ts` uses for auth's bearer grammar; the amount
 * grammar is reached through `sign` and `verify`, the door a holder uses. Either way this file
 * reads `dist`, so `node scripts/build-packages.mjs` runs first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReceipts } from '../packages/receipt/dist/index.js';
import type { Receipt } from '../packages/receipt/dist/index.js';
import {
  decodeBase64Url,
  encodeBase64Url,
  keyId,
} from '../packages/receipt/dist/lib/receipt-signing.js';
import { fromBase64Url, toBase64Url, toHex } from '#src/bytes.ts';
import { systemDigest } from '#src/adapters/index.ts';
import { decodeAmountWire, encodeAmount } from '#src/money.ts';
import { decodeLegs } from '#src/sql-kit.ts';

/** Empty, the byte extremes, an odd length, every byte value, non-ASCII, and 64 KiB. */
const CORPUS: ReadonlyArray<readonly [string, Uint8Array]> = [
  ['empty', new Uint8Array(0)],
  ['one 0x00', new Uint8Array([0])],
  ['one 0xff', new Uint8Array([255])],
  ['odd length', new Uint8Array([1, 2, 3])],
  [
    'every byte value',
    new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
  ],
  ['non-ascii utf8', new TextEncoder().encode('héllo — 世界 🌍')],
  ['64 KiB of zeros', new Uint8Array(65_536)],
  ['64 KiB of 0xff', new Uint8Array(65_536).fill(255)],
  ...Array.from({ length: 128 }, (_, n) => {
    const bytes = new Uint8Array(
      Array.from({ length: n % 37 }, (_, i) => (n * 31 + i * 17) % 256),
    );
    return [`generated ${n}`, bytes] as const;
  }),
];

test('receipt encodes base64url byte for byte the way the lab does', () => {
  let compared = 0;
  for (const [label, bytes] of CORPUS) {
    assert.equal(encodeBase64Url(bytes), toBase64Url(bytes), label);
    compared += 1;
  }
  assert.equal(compared, 136);
});

test('receipt decodes back to the same bytes the lab decodes to', () => {
  for (const [label, bytes] of CORPUS) {
    const text = toBase64Url(bytes);
    assert.deepEqual([...decodeBase64Url(text)], [...bytes], label);
    assert.deepEqual([...fromBase64Url(text)], [...bytes], label);
  }
});

// The half that already drifted once. Every one of these decodes to the same bytes under a
// permissive reader, which is exactly why both must refuse it: a signature is its spelling.
test('receipt refuses every non-canonical spelling the lab refuses', () => {
  // Padding, the standard alphabet, whitespace, a bad character, a length no group can have,
  // and — the subtle family — trailing bits the decoded bytes do not use: `YR` and `YQ` decode
  // to the same single byte, and `YQ` is the only spelling of it.
  const NON_CANONICAL = [
    'YQ==',
    'YQ=',
    'a+b/',
    'YWJj\n',
    ' YWJj',
    'YWJj ',
    'YWJ j',
    'YWJjZA===',
    '====',
    '!!!!',
    'YR',
    'YQF',
    'YQP',
    '=',
    'YWJja',
  ];
  const outcome = (run: () => unknown): 'accepted' | 'refused' => {
    try {
      run();
      return 'accepted';
    } catch {
      return 'refused';
    }
  };
  let refused = 0;
  for (const text of NON_CANONICAL) {
    const theirs = outcome(() => decodeBase64Url(text));
    const ours = outcome(() => fromBase64Url(text));
    assert.equal(
      theirs,
      ours,
      `${text} is read differently by the two decoders`,
    );
    if (ours === 'refused') refused += 1;
  }
  // Agreement alone would be satisfied by two decoders that accept everything.
  assert.equal(refused, 15);
});

test('receipt hex-encodes the way the lab does, through the key id it derives', async () => {
  const digest = systemDigest();
  const SECRETS = [
    '',
    'a',
    'whsec_abc123',
    'héllo — 世界 🌍',
    'x'.repeat(4096),
    ...Array.from({ length: 64 }, (_, n) => `secret_${n * 7919}`),
  ];
  for (const secret of SECRETS) {
    const expected = toHex(
      await digest.hash(new TextEncoder().encode(secret)),
    ).slice(0, 16);
    assert.equal(
      await keyId(secret),
      expected,
      `key id for ${secret.slice(0, 12)}`,
    );
  }
  assert.equal(SECRETS.length, 69);
});

const ACCOUNT = 'usr_4c1d9e:spendable';

/** A receipt that verifies, so the only thing under test is the amount swapped into it. */
const PAYLOAD: Receipt = {
  txnId: 'txn_0f8c3a41-6d52-4b90-9c17-2e5a8b4d7f03',
  userId: 'usr_4c1d9e',
  amount: 'CREDIT:600.00',
  issuedAt: 1753574400000,
  link: { account: ACCOUNT, prevHash: '0'.repeat(64), hash: 'c8'.repeat(32) },
};

const receipts = createReceipts({ secrets: ['q40-differential'] });

/**
 * The lab's answer. `decodeLegs` is its gate on an amount held as text: it decodes, re-encodes,
 * and refuses everything that is not its own encoding.
 */
function labAccepts(wire: string): boolean {
  try {
    decodeLegs([{ account: ACCOUNT, amount: wire }]);
    return true;
  } catch {
    return false;
  }
}

/** The receipt's answer, taken through the door a holder uses rather than off its regex. */
async function receiptAccepts(
  wire: string,
  field: 'amount' | 'leg',
): Promise<boolean> {
  const payload: Receipt =
    field === 'amount'
      ? { ...PAYLOAD, amount: wire }
      : { ...PAYLOAD, legs: [{ account: ACCOUNT, amount: wire }] };
  return (await receipts.verify(await receipts.sign(payload))) !== null;
}

/**
 * Every row carries the reason it is here, and the verdict is spelled out rather than derived,
 * so the lab moving is a failure and not a silently re-agreed answer.
 *
 * Both directions are represented on purpose. A spelling the receipt takes and the lab refuses
 * is a signed lie; a spelling the lab writes and the receipt refuses is a receipt that cannot be
 * cashed. The magnitude rows are the exact 64-bit edge, one minor unit apart.
 */
const SPELLINGS: ReadonlyArray<readonly [string, string, 'accept' | 'refuse']> =
  [
    ['an ordinary credit amount', 'CREDIT:600.00', 'accept'],
    ['the other currency', 'USD:100.00', 'accept'],
    ['the debit leg of a top-up', 'CREDIT:-600.00', 'accept'],
    ['zero', 'CREDIT:0.00', 'accept'],
    ['below one whole unit', 'CREDIT:0.05', 'accept'],
    ['below one whole unit, negative', 'CREDIT:-0.50', 'accept'],
    ['the largest amount a leg holds', 'CREDIT:92233720368547758.07', 'accept'],
    [
      'the smallest amount a leg holds',
      'CREDIT:-92233720368547758.08',
      'accept',
    ],
    [
      'the range is the column, not the currency',
      'USD:92233720368547758.07',
      'accept',
    ],
    [
      'one minor unit past the largest',
      'CREDIT:92233720368547758.08',
      'refuse',
    ],
    [
      'one minor unit past the smallest',
      'CREDIT:-92233720368547758.09',
      'refuse',
    ],
    ['a magnitude no column holds', 'CREDIT:99999999999999999999.00', 'refuse'],
    ['a one-letter currency', 'X:600.00', 'refuse'],
    ['a two-letter currency', 'XY:600.00', 'refuse'],
    [
      'an ISO-shaped currency this economy does not mint',
      'XYZ:600.00',
      'refuse',
    ],
    ['a real currency this economy does not mint', 'EUR:600.00', 'refuse'],
    ['a currency whose minor unit is not hundredths', 'JPY:600', 'refuse'],
    ['a currency longer than any code', 'AAAAAAAAAAAAA:600.00', 'refuse'],
    ['the currency in lower case', 'credit:600.00', 'refuse'],
    ['the currency in mixed case', 'Credit:600.00', 'refuse'],
    ['minor units under the major-unit prefix', 'CREDIT:60000', 'refuse'],
    ['one decimal place', 'CREDIT:600.0', 'refuse'],
    ['three decimal places', 'CREDIT:600.000', 'refuse'],
    ['a leading zero', 'CREDIT:0600.00', 'refuse'],
    ['a signed zero', 'CREDIT:-0.00', 'refuse'],
    ['digit grouping', 'CREDIT:1,000.00', 'refuse'],
    ['an explicit plus', 'CREDIT:+600.00', 'refuse'],
    ['no whole part', 'CREDIT:.50', 'refuse'],
    ['no fraction', 'CREDIT:600.', 'refuse'],
    ['exponent notation', 'CREDIT:1e3', 'refuse'],
    ['a number that is not one', 'CREDIT:NaN', 'refuse'],
    ['an unbounded number', 'CREDIT:Infinity', 'refuse'],
    ['a leading space', ' CREDIT:600.00', 'refuse'],
    ['a trailing space', 'CREDIT:600.00 ', 'refuse'],
    ['a trailing field', 'CREDIT:600.00:extra', 'refuse'],
    ['a doubled colon', 'CREDIT::600.00', 'refuse'],
    ['no currency', ':600.00', 'refuse'],
    ['no colon', 'CREDIT600.00', 'refuse'],
    ['no currency and no colon', '600.00', 'refuse'],
    ['nothing after the colon', 'CREDIT:', 'refuse'],
    ['nothing at all', '', 'refuse'],
  ];

test('both sides read the same verdict off every spelling with a reason to be here', async () => {
  let accepted = 0;
  for (const [label, wire, want] of SPELLINGS) {
    const ok = want === 'accept';
    assert.equal(labAccepts(wire), ok, `lab: ${label}`);
    assert.equal(await receiptAccepts(wire, 'amount'), ok, `amount: ${label}`);
    assert.equal(await receiptAccepts(wire, 'leg'), ok, `leg: ${label}`);
    if (ok) accepted += 1;
  }
  assert.equal(SPELLINGS.length, 41);
  assert.equal(accepted, 9);
});

const CURRENCIES = [
  'CREDIT',
  'USD',
  'X',
  'XY',
  'XYZ',
  'EUR',
  'GBP',
  'JPY',
  'AAAAAAAA',
  'AAAAAAAAAAAAA',
  'credit',
  'Credit',
  'CRED1T',
];

const DECIMALS = [
  '600.00',
  '600.0',
  '600',
  '600.000',
  '0600.00',
  '-600.00',
  '-0.00',
  '0.00',
  '-0.01',
  '0.05',
  '-0.50',
  '1,000.00',
  '+600.00',
  '.50',
  '600.',
  '1e3',
  'Infinity',
  'NaN',
  '99999999999999999999.00',
  '92233720368547758.07',
  '92233720368547758.08',
  '-92233720368547758.08',
  '-92233720368547758.09',
  ' 600.00',
  '600.00 ',
];

/** Every currency against every decimal, plus the malformations that are not a pair of the two. */
const SWEEP = [
  ...CURRENCIES.flatMap((currency) =>
    DECIMALS.map((decimal) => `${currency}:${decimal}`),
  ),
  'CREDIT:600.00:extra',
  ':600.00',
  'CREDIT600.00',
  'CREDIT::600.00',
  '600.00',
  'CREDIT:',
  '',
];

test('the two grammars agree across the whole cross product', async () => {
  const disagreements: string[] = [];
  let tried = 0;
  let accepted = 0;
  for (const wire of SWEEP) {
    tried += 1;
    const lab = labAccepts(wire);
    if (lab) accepted += 1;
    for (const field of ['amount', 'leg'] as const) {
      if ((await receiptAccepts(wire, field)) !== lab) {
        disagreements.push(
          `${wire} in ${field}: lab ${lab ? 'takes' : 'refuses'} it`,
        );
      }
    }
  }
  assert.deepEqual(disagreements, []);
  // Agreement on its own is satisfied by two grammars that take everything, or nothing.
  assert.equal(tried, 332);
  assert.equal(accepted, 16);
});

/**
 * Spellings the lab's decoder reads but its encoder would never write. They are why the receipt
 * targets what `encodeAmount` writes rather than what `decodeAmountWire` will take: an older
 * engine emit meant six hundred credits by `CREDIT:60000`, and the decoder alone reads it as
 * sixty thousand.
 */
const NOT_ITS_OWN_ENCODING: ReadonlyArray<readonly [string, bigint]> = [
  ['CREDIT:60000', 6_000_000n],
  ['CREDIT:600.0', 60_000n],
  ['CREDIT:600', 60_000n],
  ['CREDIT:0600.00', 60_000n],
  ['CREDIT:-0.00', 0n],
];

test('a spelling the lab can read but would never write is refused on both sides', async () => {
  for (const [wire, minor] of NOT_ITS_OWN_ENCODING) {
    const amount = decodeAmountWire(wire);
    assert.equal(amount.minor, minor, wire);
    assert.notEqual(encodeAmount(amount), wire, wire);
    assert.equal(labAccepts(wire), false, `lab: ${wire}`);
    assert.equal(
      await receiptAccepts(wire, 'amount'),
      false,
      `amount: ${wire}`,
    );
    assert.equal(await receiptAccepts(wire, 'leg'), false, `leg: ${wire}`);
  }
  assert.equal(NOT_ITS_OWN_ENCODING.length, 5);
});
