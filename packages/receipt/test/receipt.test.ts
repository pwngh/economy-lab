/**
 * @pwngh/economy-receipt
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
import { createReceipts, Receipts } from '../src/index.js';
import type { LedgerTransaction, Receipt } from '../src/index.js';
import {
  decodeTextBase64Url,
  encodeTextBase64Url,
  keyId,
  sign,
} from '../src/lib/receipt-signing.js';

const SECRET = 'ba9d1c07e4f8a3b5';
/** What `SIGNING_SECRET` held where the README's two sample receipts were signed. */
const README_SECRET = 's3cret1';
const TXN = 'txn_0f8c3a41-6d52-4b90-9c17-2e5a8b4d7f03';
const USER = 'usr_4c1d9e';
const ISSUED = 1753574400000;
const GENESIS = '0'.repeat(64);
const HEAD = 'c81d4e2b9f0a37561e8d4c2a90bf73e5d16a8c4f2b09e7d35a1c6f8b420d9e73';

/** A $5.00 top-up at 120 credits to the dollar, as the ledger posts one. */
const RECEIPT: Receipt = {
  txnId: TXN,
  userId: USER,
  amount: 'CREDIT:600.00',
  issuedAt: ISSUED,
  link: { account: `${USER}:spendable`, prevHash: GENESIS, hash: HEAD },
  legs: [
    { account: `${USER}:spendable`, amount: 'CREDIT:-600.00' },
    { account: 'system:issuance', amount: 'CREDIT:600.00' },
  ],
  kind: 'topUp',
};

const BARE: Receipt = {
  txnId: TXN,
  userId: USER,
  amount: 'CREDIT:600.00',
  issuedAt: ISSUED,
  link: { account: `${USER}:spendable`, prevHash: GENESIS, hash: HEAD },
};

/** What the ledger holds for {@link RECEIPT}: the lab's `Transaction`, structurally. */
const POSTED: LedgerTransaction = {
  id: TXN,
  links: [
    { account: `${USER}:spendable`, prevHash: GENESIS, hash: HEAD },
    {
      account: 'system:issuance',
      prevHash: GENESIS,
      hash: `a${HEAD.slice(1)}`,
    },
  ],
};

const body = (value: string) => value.slice(0, value.lastIndexOf('.'));
const signature = (value: string) => value.slice(value.lastIndexOf('.') + 1);

test('a signed receipt round-trips to the payload it was issued for', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const value = await receipts.sign(RECEIPT);

  assert.equal(value.startsWith(`rcpt1.${await keyId(SECRET)}.`), true);
  assert.equal(value.split('.').length, 4);
  assert.equal(encodeURIComponent(value), value);
  assert.deepEqual(await receipts.verify(value), RECEIPT);
});

test('the codec reports its configuration and nothing else', () => {
  const receipts = createReceipts({
    secrets: [SECRET, 'retired'],
    ttlMs: 900_000,
  });

  assert.equal(receipts instanceof Receipts, true);
  assert.equal(receipts.secretCount, 2);
  assert.equal(receipts.ttlMs, 900_000);
  assert.equal(createReceipts({ secrets: [SECRET] }).ttlMs, undefined);
  assert.equal(Object.keys(receipts).length, 0);
});

test('changing one character of the payload stops it verifying', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const value = await receipts.sign(RECEIPT);
  const at = 30;

  assert.equal(at < value.lastIndexOf('.'), true);
  const swapped = value[at] === 'A' ? 'B' : 'A';
  const tampered = value.slice(0, at) + swapped + value.slice(at + 1);

  assert.notEqual(tampered, value);
  assert.equal(tampered.length, value.length);
  assert.equal(await receipts.verify(tampered), null);
});

test('changing one character of the signature stops it verifying', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const value = await receipts.sign(RECEIPT);
  const sig = signature(value);
  const swapped = sig[0] === 'A' ? 'B' : 'A';
  const tampered = `${body(value)}.${swapped}${sig.slice(1)}`;

  assert.notEqual(tampered, value);
  assert.equal(await receipts.verify(tampered), null);
});

// `atob` is the lenient decoder: it takes the standard alphabet, `=` padding, embedded
// whitespace, and the two trailing bits a 43-character signature does not use. Unless the decode
// insists on the one canonical spelling, a caller treating the receipt string as an identity —
// a redeemed set, an idempotency key, a seen-cache — can be handed a fresh string for the same
// receipt every time and will redeem it again.
test('one receipt has exactly one spelling', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  // HMAC is deterministic, so issuedAt walks until the signature holds both base64url-only
  // characters and the standard-alphabet respelling is a real difference.
  let issuedAt = ISSUED;
  let value = await receipts.sign({ ...BARE, issuedAt });
  while (!signature(value).includes('-') || !signature(value).includes('_')) {
    issuedAt += 1;
    value = await receipts.sign({ ...BARE, issuedAt });
  }
  const sig = signature(value);
  const respelt = (s: string) => receipts.verify(`${body(value)}.${s}`);

  assert.equal(sig.length, 43);
  assert.deepEqual(
    await respelt(sig),
    { ...BARE, issuedAt },
    'the canonical spelling verifies',
  );

  const standard = sig.replace(/-/g, '+').replace(/_/g, '/');
  assert.notEqual(standard, sig);
  assert.equal(
    await respelt(standard),
    null,
    'the standard alphabet is not base64url',
  );
  assert.equal(await respelt(`${sig}=`), null, 'padding is not canonical');
  assert.equal(
    await respelt(`${sig.slice(0, 4)} ${sig.slice(4)}`),
    null,
    'an embedded space is not canonical',
  );
  assert.equal(
    await respelt(`${sig.slice(0, 4)}\n${sig.slice(4)}`),
    null,
    'an embedded newline is not canonical',
  );

  // A 32-byte signature fills 43 characters with two bits to spare, so the last character has
  // exactly three other spellings that decode to the same bytes.
  const ALPHA =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const idx = ALPHA.indexOf(sig.slice(-1)!);
  const respellings = new Set<string>();
  for (let bits = 1; bits < 4; bits += 1) {
    const alt = ALPHA[(idx & ~0b11) | ((idx & 0b11) ^ bits)]!;
    respellings.add(`${sig.slice(0, -1)}${alt}`);
  }
  assert.equal(respellings.size, 3, 'three respellings, all of them different');
  assert.equal(
    respellings.has(sig),
    false,
    'and none of them the canonical one',
  );
  for (const respelling of respellings) {
    assert.equal(
      await respelt(respelling),
      null,
      'a spare-bit respelling of the signature is refused',
    );
  }
});

test('a receipt signed under a secret the verifier does not hold is null', async () => {
  const issuer = createReceipts({ secrets: ['alpha'] });
  const stranger = createReceipts({ secrets: ['beta'] });
  const value = await issuer.sign(RECEIPT);

  assert.deepEqual(await issuer.verify(value), RECEIPT);
  assert.equal(await stranger.verify(value), null);
  // The stranger can still read which key it was, and see that it is not one of theirs.
  assert.equal(stranger.kidOf(value), await keyId('alpha'));
  assert.notEqual(await keyId('alpha'), await keyId('beta'));
});

test('prepending a new secret keeps receipts signed under the old one verifying', async () => {
  const before = createReceipts({ secrets: ['secret1'] });
  const issued = await before.sign(RECEIPT);

  // The rotation: the new secret goes in front, the old one stays behind it.
  const after = createReceipts({ secrets: ['secret2', 'secret1'] });
  assert.equal(after.secretCount, 2);
  assert.deepEqual(await after.verify(issued), RECEIPT);

  // The old receipt still names the old key, so rotation is visible in the field.
  assert.equal(after.kidOf(issued), await keyId('secret1'));

  // New receipts are signed with the first entry, so the old codec no longer reads them.
  const reissued = await after.sign(RECEIPT);
  assert.equal(after.kidOf(reissued), await keyId('secret2'));
  assert.equal(await before.verify(reissued), null);

  // And dropping secret1 too early rejects everything issued before the rotation.
  const tooEager = createReceipts({ secrets: ['secret2'] });
  assert.equal(await tooEager.verify(issued), null);
  assert.deepEqual(await tooEager.verify(reissued), RECEIPT);
});

test('the key id is 16 lowercase hex and never the secret itself', async () => {
  const kid = await keyId(SECRET);

  assert.equal(kid.length, 16);
  assert.match(kid, /^[0-9a-f]{16}$/);
  assert.equal(SECRET.includes(kid), false);
  assert.equal(await keyId(SECRET), kid); // stable
  assert.notEqual(await keyId(`${SECRET}x`), kid);
});

test('a receipt older than ttlMs is null while a fresh one is not', async () => {
  const receipts = createReceipts({ secrets: [SECRET], ttlMs: 900_000 });
  const fresh = await receipts.sign({ ...BARE, issuedAt: Date.now() - 1000 });
  const stale = await receipts.sign({
    ...BARE,
    issuedAt: Date.now() - 900_001,
  });

  assert.notEqual(await receipts.verify(fresh), null);
  assert.equal(await receipts.verify(stale), null);

  // The same stale string is still good to a codec that sets no lifetime.
  const forever = createReceipts({ secrets: [SECRET] });
  assert.equal((await forever.verify(stale))?.txnId, TXN);
});

test('malformed input of every shape is null, never a throw', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const value = await receipts.sign(RECEIPT);
  const kid = await keyId(SECRET);

  const garbage = [
    '',
    'x',
    '.',
    '....',
    'rcpt1.',
    `rcpt1.${kid}`, // key id but no payload
    `rcpt1.${kid}.`, // payload separator but nothing after it
    'rcpt1.nothex0000000.abc.def', // key id outside the alphabet
    `rcpt1.${kid.slice(0, 8)}.abc.def`, // key id of the wrong width
    `rcpt1.${kid}.abc.###`, // signature outside base64url
    'not-a-receipt-at-all',
    '{}',
    'null',
    body(value), // the payload with its signature cut off
    signature(value), // the signature with its payload cut off
    value.slice(0, -4), // truncated in transit
  ];

  for (const bad of garbage) {
    assert.equal(await receipts.verify(bad), null, `expected null for ${bad}`);
  }
  assert.equal(garbage.length, 16);
});

test('the signature covers the encoded bytes, not the values they stand for', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const value = await receipts.sign(BARE);
  const kid = await keyId(SECRET);

  // The very same fields, written in a different key order.
  const reordered = {
    link: BARE.link,
    issuedAt: ISSUED,
    amount: 'CREDIT:600.00',
    userId: USER,
    txnId: TXN,
  };
  const rebody = `rcpt1.${kid}.${encodeTextBase64Url(JSON.stringify(reordered))}`;
  const encoded = body(value).slice(`rcpt1.${kid}.`.length);

  // Same receipt by value...
  assert.deepEqual(JSON.parse(decodeTextBase64Url(encoded)), reordered);
  // ...different bytes, so the signature issued for the first does not cover the second.
  assert.notEqual(rebody, body(value));
  assert.equal(await receipts.verify(`${rebody}.${signature(value)}`), null);
  assert.deepEqual(await receipts.verify(value), BARE);
});

test('the signature covers the key id, so restamping it is a forgery', async () => {
  const receipts = createReceipts({ secrets: ['secret2', 'secret1'] });
  const value = await receipts.sign(BARE); // signed under secret2
  const kid = await keyId('secret2');
  const encoded = body(value).slice(`rcpt1.${kid}.`.length);

  // Restamping alone proves only that the id picked the wrong secret. The signed span is the
  // claim, so it is checked against the bytes directly: the key id is inside it.
  assert.equal(value, await sign(`rcpt1.${kid}.${encoded}`, 'secret2'));
  assert.notEqual(value, await sign(`rcpt1.${encoded}`, 'secret2'));
  assert.notEqual(
    value,
    await sign(`rcpt1.${await keyId('secret1')}.${encoded}`, 'secret2'),
  );

  const restamped = value.replace(
    `rcpt1.${kid}.`,
    `rcpt1.${await keyId('secret1')}.`,
  );
  assert.equal(receipts.kidOf(restamped), await keyId('secret1'));
  assert.notEqual(restamped, value);
  assert.equal(await receipts.verify(restamped), null);
});

test('a correctly signed value under another scheme tag is null', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const forged = await sign(
    `rcpt0.${await keyId(SECRET)}.${encodeTextBase64Url(JSON.stringify(BARE))}`,
    SECRET,
  );

  assert.equal(forged.startsWith('rcpt0.'), true);
  assert.equal(await receipts.verify(forged), null);
});

test('a correctly signed payload that is not receipt-shaped is null', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const kid = await keyId(SECRET);
  const notReceipts = [
    { ...BARE, amount: '600 credits' }, // not the wire form
    { ...BARE, amount: 'CREDIT:600' }, // wire form without the two decimals
    { ...BARE, userId: '' }, // no owner
    { ...BARE, issuedAt: '1753574400000' }, // a timestamp as text
    { ...BARE, issuedAt: 1e17 }, // a timestamp no Date can hold
    { txnId: TXN, userId: USER }, // fields missing
    [BARE], // an array of them
    'a bare string',
  ];

  for (const payload of notReceipts) {
    const forged = await sign(
      `rcpt1.${kid}.${encodeTextBase64Url(JSON.stringify(payload))}`,
      SECRET,
    );
    assert.equal(await receipts.verify(forged), null, `verified ${forged}`);
  }
  assert.equal(notReceipts.length, 8);
});

/**
 * The amount grammar, standalone. `test/dedupe-receipt.test.ts` in the lab drives these same
 * spellings through the ledger's own decoder as well; this holds the package to the rule when it
 * is tested alone, which is how it is tested before it is published.
 */
const AMOUNTS: ReadonlyArray<readonly [string, 'accept' | 'refuse']> = [
  ['CREDIT:600.00', 'accept'],
  ['USD:100.00', 'accept'],
  ['CREDIT:-600.00', 'accept'],
  ['CREDIT:0.00', 'accept'],
  ['CREDIT:-0.05', 'accept'],
  ['CREDIT:92233720368547758.07', 'accept'],
  ['CREDIT:-92233720368547758.08', 'accept'],
  // One minor unit past what the ledger's BIGINT columns hold, either way.
  ['CREDIT:92233720368547758.08', 'refuse'],
  ['CREDIT:-92233720368547758.09', 'refuse'],
  ['CREDIT:99999999999999999999.00', 'refuse'],
  // A currency no economy here mints. `[A-Z]+` took all four of these.
  ['X:600.00', 'refuse'],
  ['XYZ:600.00', 'refuse'],
  ['EUR:600.00', 'refuse'],
  ['AAAAAAAAAAAAA:600.00', 'refuse'],
  // A second spelling of a number that already has one.
  ['CREDIT:60000', 'refuse'],
  ['CREDIT:600.0', 'refuse'],
  ['CREDIT:0600.00', 'refuse'],
  ['CREDIT:-0.00', 'refuse'],
  ['CREDIT:1,000.00', 'refuse'],
  ['credit:600.00', 'refuse'],
];

test('an amount no posting could carry is refused wherever it appears', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  let accepted = 0;
  for (const [amount, want] of AMOUNTS) {
    const ok = want === 'accept';
    assert.equal(
      (await receipts.verify(await receipts.sign({ ...BARE, amount }))) !==
        null,
      ok,
      `amount ${amount}`,
    );
    // The per-leg check is a second call site and has its own history of drifting from the first.
    const legged = {
      ...BARE,
      legs: [{ account: `${USER}:spendable`, amount }],
    };
    assert.equal(
      (await receipts.verify(await receipts.sign(legged))) !== null,
      ok,
      `leg ${amount}`,
    );
    if (ok) accepted += 1;
  }
  assert.equal(AMOUNTS.length, 20);
  assert.equal(accepted, 7);
});

test('a receipt whose chain link is edited fails', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const kid = await keyId(SECRET);

  // Re-signing an edited link is the strongest forgery a secret holder can mount, and the
  // shape guard still rejects a link the ledger could never have written.
  const malformed = [
    { ...BARE.link, hash: HEAD.toUpperCase() }, // not the ledger's lowercase spelling
    { ...BARE.link, hash: HEAD.slice(0, 63) }, // short of 32 bytes
    { ...BARE.link, hash: `${HEAD.slice(0, 63)}z` }, // outside hex
    { ...BARE.link, prevHash: '' }, // no predecessor at all
    { ...BARE.link, account: '' }, // no account
    { account: `${USER}:spendable`, hash: HEAD }, // prevHash missing
    HEAD, // a bare hash instead of a link
  ];

  for (const link of malformed) {
    const forged = await sign(
      `rcpt1.${kid}.${encodeTextBase64Url(JSON.stringify({ ...BARE, link }))}`,
      SECRET,
    );
    assert.equal(
      await receipts.verify(forged),
      null,
      `verified ${JSON.stringify(link)}`,
    );
  }
  assert.equal(malformed.length, 7);

  // A well-formed but different hash passes `verify` — only the ledger can refuse it.
  const swapped = {
    ...BARE,
    link: { ...BARE.link, hash: `a${HEAD.slice(1)}` },
  };
  const value = await receipts.sign(swapped);
  assert.deepEqual(await receipts.verify(value), swapped);
  assert.equal(await receipts.verifyAgainst(value, POSTED), null);
});

test('a receipt verified against the posting the ledger holds returns the payload', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const value = await receipts.sign(RECEIPT);

  assert.deepEqual(await receipts.verifyAgainst(value, POSTED), RECEIPT);
  // The weaker check passes either way; the ledger is what tells them apart.
  assert.deepEqual(await receipts.verify(value), RECEIPT);
});

test('a receipt verified against a mismatched transaction fails', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const value = await receipts.sign(RECEIPT);

  const mismatches: LedgerTransaction[] = [
    { ...POSTED, id: 'txn_11111111-2222-3333-4444-555555555555' }, // another posting
    { id: TXN, links: [] }, // committed, but touched no account
    {
      id: TXN, // the account is there, its history is not
      links: [
        {
          account: `${USER}:spendable`,
          prevHash: GENESIS,
          hash: `b${HEAD.slice(1)}`,
        },
      ],
    },
    {
      id: TXN, // the head matches, what it followed does not
      links: [
        {
          account: `${USER}:spendable`,
          prevHash: `c${HEAD.slice(1)}`,
          hash: HEAD,
        },
      ],
    },
    {
      id: TXN, // right hashes, wrong account
      links: [{ account: 'system:issuance', prevHash: GENESIS, hash: HEAD }],
    },
  ];

  for (const transaction of mismatches) {
    assert.equal(
      await receipts.verifyAgainst(value, transaction),
      null,
      `matched ${JSON.stringify(transaction)}`,
    );
  }
  assert.equal(mismatches.length, 5);

  // A signed receipt for a transaction that never committed is the forgery `verify` cannot see.
  const invented = await receipts.sign({
    ...RECEIPT,
    txnId: 'txn_never-committed',
  });
  assert.equal((await receipts.verify(invented))?.txnId, 'txn_never-committed');
  assert.equal(await receipts.verifyAgainst(invented, POSTED), null);
});

test('verifyAgainst refuses a forged receipt before it ever looks at the ledger', async () => {
  const issuer = createReceipts({ secrets: ['alpha'] });
  const stranger = createReceipts({ secrets: ['beta'] });
  const value = await issuer.sign(RECEIPT);

  assert.equal(await stranger.verifyAgainst(value, POSTED), null);
  assert.deepEqual(await issuer.verifyAgainst(value, POSTED), RECEIPT);
  // Junk in the transaction slot is a null, not a throw.
  assert.equal(
    await issuer.verifyAgainst(value, null as unknown as LedgerTransaction),
    null,
  );
  assert.equal(
    await issuer.verifyAgainst(value, {
      id: TXN,
    } as unknown as LedgerTransaction),
    null,
  );
});

test('a verified receipt renders for a support desk', async () => {
  // RECEIPT carries a fixed issuedAt so the rendering below is stable, which makes it older
  // than any lifetime worth setting. Verify without one, then render with one.
  const forever = createReceipts({ secrets: [SECRET] });
  const payload = await forever.verify(await forever.sign(RECEIPT));
  assert.notEqual(payload, null);

  const dated = createReceipts({
    secrets: [SECRET],
    ttlMs: 1000 * 60 * 60 * 24 * 30,
  });

  assert.equal(
    dated.describe(payload as Receipt),
    [
      `Receipt ${TXN}`,
      `  User      ${USER}`,
      '  Operation topUp',
      '  Amount    CREDIT:600.00',
      '  Issued    2025-07-27T00:00:00.000Z',
      '  Expires   2025-08-26T00:00:00.000Z',
      `  Account   ${USER}:spendable`,
      `  Chain     ${GENESIS} -> ${HEAD}`,
      '  Legs (debit-positive, as posted)',
      '    usr_4c1d9e:spendable  CREDIT:-600.00',
      '    system:issuance       CREDIT:600.00',
    ].join('\n'),
  );

  // No lifetime configured means no expiry line, and a bare receipt renders without legs.
  const bare = forever.describe(BARE);
  assert.equal(bare.includes('Expires'), false);
  assert.equal(bare.includes('Legs'), false);
  assert.equal(bare.split('\n').length, 6);
});

test('a custom codec replaces the whole payload encoding, wrapper and all', async () => {
  const brittle = createReceipts({
    secrets: [SECRET],
    encode: (r) =>
      [
        r.txnId,
        r.userId,
        r.amount,
        String(r.issuedAt),
        r.link.account,
        r.link.prevHash,
        r.link.hash,
      ].join('~'),
    decode: (text) => {
      const parts = text.split('~');
      if (parts.length !== 7) throw new Error('not seven fields');
      return {
        txnId: parts[0],
        userId: parts[1],
        amount: parts[2],
        issuedAt: Number(parts[3]),
        link: { account: parts[4], prevHash: parts[5], hash: parts[6] },
      };
    },
  });
  const value = await brittle.sign(BARE);
  const kid = await keyId(SECRET);

  assert.equal(
    value.startsWith(`rcpt1.${kid}.${TXN}~${USER}~CREDIT:600.00~`),
    true,
  );
  assert.deepEqual(await brittle.verify(value), BARE);
  assert.deepEqual(await brittle.verifyAgainst(value, POSTED), BARE);

  // A decode that throws is a verification failure like any other, even when signed correctly.
  const unparseable = await sign(`rcpt1.${kid}.only~three~fields`, SECRET);
  assert.equal(await brittle.verify(unparseable), null);

  // And the default codec cannot read the custom one's output.
  assert.equal(await createReceipts({ secrets: [SECRET] }).verify(value), null);
});

test('a codec with no secrets is refused at construction', () => {
  assert.throws(() => createReceipts({ secrets: [] }), {
    name: 'TypeError',
    message:
      'Receipts requires at least one secret. A receipt is always signed.',
  });
  assert.throws(
    () => new Receipts({ secrets: undefined as unknown as string[] }),
    { name: 'TypeError' },
  );
});

test('the README claims hold against the tree, not memory', async () => {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

  // Derived, so a rename moves the pin with it.
  assert.equal(
    md.startsWith(`# ${String(pkg.name).replace('@pwngh/economy-', '')}\n`),
    true,
  );

  // Whole strings, not prefixes: an elision is where a wrong character survives.
  const usage = createReceipts({ secrets: [README_SECRET] });
  assert.ok(
    md.includes(await usage.sign(RECEIPT)),
    'the Usage sample is the receipt this codec signs',
  );

  const readable = createReceipts({
    secrets: [README_SECRET],
    encode: (r) =>
      [
        r.txnId,
        r.userId,
        r.amount,
        r.issuedAt,
        r.link.account,
        r.link.prevHash,
        r.link.hash,
      ].join('~'),
  });
  assert.ok(
    md.includes(await readable.sign(RECEIPT)),
    'the custom-encoding sample is the receipt that codec signs',
  );

  assert.ok(
    md.includes(
      createReceipts({
        secrets: [README_SECRET],
        ttlMs: 1000 * 60 * 60 * 24 * 30,
      }).describe(RECEIPT),
    ),
    'the support-desk rendering is what describe returns',
  );

  assert.ok(
    md.includes(await keyId('secret1')),
    'the rotation kid is the real one',
  );
  assert.ok(
    md.includes(await keyId('secret2')),
    'the reissued kid is the real one',
  );

  assert.ok(
    md.includes('## What this package is not') ||
      md.includes('### What this package is not'),
  );
  for (const owned of [
    'Merkle roots',
    'verifyExport',
    'solvency',
    'findByHash',
  ]) {
    assert.ok(md.includes(owned), `the boundary names ${owned} as the lab's`);
  }
  assert.ok(md.includes('never throws'), 'the null contract is stated');

  for (const name of ['sign', 'verify', 'verifyAgainst', 'kidOf', 'describe']) {
    assert.ok(md.includes(name), `README covers ${name}`);
  }
  assert.equal(
    Object.getOwnPropertyNames(Receipts.prototype).sort().join(','),
    'constructor,describe,kidOf,secretCount,sign,ttlMs,verify,verifyAgainst',
  );

  assert.equal(
    pkg.dependencies,
    undefined,
    'the zero-dependency claim is real',
  );
  assert.ok(md.includes('No dependencies'), 'and stated');
});

test('a key set that cannot sign is refused at construction', async () => {
  // An empty secret is not a secret. Web Crypto refuses a zero-length key, and because verify
  // has one failure value that refusal would surface as "every receipt is forged".
  assert.throws(() => createReceipts({ secrets: [''] }), {
    name: 'TypeError',
    message:
      'Every Receipts secret must be a non-empty string. An empty secret cannot sign.',
  });
  assert.throws(() => createReceipts({ secrets: [SECRET, ''] }), {
    name: 'TypeError',
  });

  // A secret that is not a string is worse: TextEncoder would stringify it, so a codec built
  // from an unset config value would sign under a guessable literal.
  for (const bad of [null, undefined, 123, {}, [], true]) {
    assert.throws(
      () => createReceipts({ secrets: [bad as unknown as string] }),
      { name: 'TypeError' },
      `accepted ${String(bad)}`,
    );
  }

  // A hole is not undefined to `every`, which skips it. The copy the codec keeps is dense.
  assert.throws(() => createReceipts({ secrets: new Array(1) as string[] }), {
    name: 'TypeError',
  });
});

test('a lifetime that is not a count of milliseconds is refused at construction', async () => {
  // Number(process.env.RECEIPT_TTL) on an unset variable is NaN, and every comparison against
  // NaN is false, so an unchecked lifetime would silently mean "never expires".
  for (const ttlMs of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    '900000',
    null,
  ]) {
    assert.throws(
      () => createReceipts({ secrets: [SECRET], ttlMs: ttlMs as number }),
      { name: 'TypeError' },
      `accepted ${String(ttlMs)}`,
    );
  }
  assert.equal(createReceipts({ secrets: [SECRET], ttlMs: 0 }).ttlMs, 0);
  assert.equal(createReceipts({ secrets: [SECRET] }).ttlMs, undefined);
});

test('a receipt at exactly ttlMs verifies and one millisecond past it does not', async () => {
  const ttlMs = 900_000;
  const receipts = createReceipts({ secrets: [SECRET], ttlMs });
  const now = 1_800_000_000_000;
  const real = Date.now;
  try {
    Date.now = () => now;
    const at = async (age: number) =>
      (await receipts.verify(
        await receipts.sign({ ...BARE, issuedAt: now - age }),
      )) !== null;

    assert.equal(await at(ttlMs - 1), true);
    assert.equal(
      await at(ttlMs),
      true,
      'the window closes after ttlMs, not at it',
    );
    assert.equal(await at(ttlMs + 1), false);
  } finally {
    Date.now = real;
  }
});

test('describe stays total at the far edge of the range a Date can hold', async () => {
  // isReceipt admits an issuedAt up to the largest epoch millisecond a Date holds, so the
  // expiry line lands past the end of time unless it is clamped.
  const MAX_TIME = 8.64e15;
  const receipts = createReceipts({ secrets: [SECRET], ttlMs: 1 });
  const payload = await receipts.verify(
    await receipts.sign({ ...BARE, issuedAt: MAX_TIME }),
  );

  assert.notEqual(payload, null, 'a far-future receipt verifies');
  const rendered = receipts.describe(payload as Receipt);
  assert.match(rendered, /^ {2}Expires {3}\+275760-09-13T00:00:00\.000Z$/m);
  assert.match(rendered, /^ {2}Issued {4}\+275760-09-13T00:00:00\.000Z$/m);

  const far = createReceipts({ secrets: [SECRET] });
  const early = await far.verify(
    await far.sign({ ...BARE, issuedAt: -MAX_TIME }),
  );
  assert.match(far.describe(early as Receipt), /^ {2}Issued {4}-271821-04-20/m);
});

test('verifyAgainst is null, never a throw, on a transaction it cannot read', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });
  const value = await receipts.sign(RECEIPT);
  const junk: unknown[] = [
    null,
    undefined,
    'txn_0f8c3a41',
    { id: TXN },
    { id: TXN, links: 'not an array' },
    { id: TXN, links: [null] },
    { id: TXN, links: [undefined] },
    { id: TXN, links: [{}] },
    {
      id: TXN,
      links: [
        {
          get account(): string {
            throw new Error('the read surface faulted');
          },
        },
      ],
    },
  ];

  for (const transaction of junk) {
    assert.equal(
      await receipts.verifyAgainst(value, transaction as LedgerTransaction),
      null,
      `matched ${String(transaction)}`,
    );
  }
  assert.equal(junk.length, 9);
});

test('verifyAgainst settles the chain link, not the legs the payload claims', async () => {
  const receipts = createReceipts({ secrets: [SECRET] });

  // The link is the real one and the legs are invented. The ledger's hash does cover the legs,
  // but nothing here recomputes it, so a secret holder can keep the link and change the legs.
  const lying = {
    ...RECEIPT,
    legs: [{ account: `${USER}:spendable`, amount: 'CREDIT:-99999.00' }],
  };
  const value = await receipts.sign(lying);
  const checked = await receipts.verifyAgainst(value, POSTED);

  assert.deepEqual(checked, lying);
  assert.notDeepEqual(checked?.legs, RECEIPT.legs);

  // So the boundary is stated where a reader would otherwise take the stronger reading.
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(
    md.includes('does not re-derive the legs'),
    'the README says what a matching link does not settle',
  );
  const src = readFileSync(
    new URL('../src/lib/receipt.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    src.includes('does not re-derive the legs'),
    'and so does the TSDoc on verifyAgainst',
  );
});

test('the bound secrets do not change when the caller mutates the array afterward', async () => {
  const secrets = ['secret1'];
  const receipts = createReceipts({ secrets });
  const value = await receipts.sign(RECEIPT);

  secrets.length = 0;
  secrets.push('secret2');

  assert.equal(receipts.secretCount, 1);
  assert.deepEqual(await receipts.verify(value), RECEIPT);
});
