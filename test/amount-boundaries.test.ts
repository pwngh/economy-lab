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
 * Every layer that reads back an amount this system wrote — the balance cache, the HTTP store
 * wire, the SQL JSON columns, the stored Operation and the Amount-brand walk — re-encodes what it
 * decoded and refuses any other spelling. The four rosters at the end are the count. They resolve,
 * from the source, which files read stored text leniently, which read it through the strict
 * decoder, which write a stored Operation, and which can reach the raw walk at all — so a sixth
 * reader, or a fourth writer, cannot appear without one.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { createEconomy, memoryPorts } from '#src/index.ts';
import { decodeAmounts, toAmount } from '#src/money.ts';
import { decodeWire, encodeWire } from '#src/adapters/http-wire.ts';
import { decodeLegs, encodeOperation, rowToInbox } from '#src/sql-kit.ts';
import { spendable } from '#src/accounts.ts';
import { testLogger } from '#test/support/capabilities.ts';
import { KINDS, SAMPLES } from '#test/support/operation-samples.ts';

import type { Cache, InboxMessage } from '#src/ports.ts';
import type { Operation } from '#src/contract.ts';

// The bytes an older engine emit wrote for six hundred credits. Sixty thousand credits is itself
// a valid amount, so nothing but the re-encode separates the two readings. A zero would prove
// nothing: 'CREDIT:0' and 'CREDIT:0.00' decode alike.
const NON_CANONICAL = 'CREDIT:60000';

// What NON_CANONICAL misreads as. No refusal may print it — an operator repairing a row to this
// value would inflate it a hundredfold.
const MISREADING = 'CREDIT:60000.00';

function refusal(error: Error & { code?: string }): true {
  assert.equal(error.code, 'MONEY.INVALID_AMOUNT');
  assert.ok(error.message.includes(NON_CANONICAL), error.message);
  assert.ok(!error.message.includes(MISREADING), error.message);
  return true;
}

function plantedCache(value: string): Cache {
  return {
    get: async () => value,
    set: async () => {},
    invalidate: async () => {},
  };
}

const WIRE_LEG = { account: spendable('usr_boundary'), amount: NON_CANONICAL };

const WIRE_TRANSACTION = {
  id: 'txn_boundary',
  postedAt: 1,
  legs: [WIRE_LEG],
  links: [],
};

// One payload per decodeWire member, each carrying NON_CANONICAL where that record spells an
// amount. Every member of the roster decodes one, so the table and the roster are the same size.
const WIRE_DECODERS: ReadonlyArray<
  readonly [keyof typeof decodeWire, unknown]
> = [
  ['amount', NON_CANONICAL],
  ['movement', { legs: [WIRE_LEG] }],
  ['posting', { txnId: 'txn_boundary', legs: [WIRE_LEG], meta: {} }],
  ['transaction', WIRE_TRANSACTION],
  ['claim', { claimed: false, transaction: WIRE_TRANSACTION }],
  ['sale', { price: NON_CANONICAL, fee: 'CREDIT:0.00', legs: [WIRE_LEG] }],
  ['saga', { reserve: NON_CANONICAL, payoutUsd: null }],
  ['subscription', { price: NON_CANONICAL }],
  ['promoGrant', { amount: NON_CANONICAL }],
  ['inboxMessage', { operation: { kind: 'topUp', amount: NON_CANONICAL } }],
  ['velocity', { spent: NON_CANONICAL }],
  ['lot', { amount: NON_CANONICAL }],
  [
    'statement',
    {
      account: spendable('usr_boundary'),
      entries: [{ txnId: 'txn_boundary', amount: NON_CANONICAL, postedAt: 1 }],
      cursor: null,
    },
  ],
  [
    'storedLink',
    {
      txnId: 'txn_boundary',
      legs: [WIRE_LEG],
      meta: {},
      prevHash: '0'.repeat(64),
      hash: '1'.repeat(64),
    },
  ],
];

const ROOT = new URL('../', import.meta.url);

// The source the tree ships: the lab's own src/, and one src/ per package. A reader lives in the
// lab; a writer of a stored column can live in either half, because the two SQL engines ship as
// packages.
const SHIPPED_ROOTS = [
  'src',
  ...readdirSync(new URL('packages/', ROOT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/src`),
];

function sourcesUnder(root: string): string[] {
  return readdirSync(new URL(`${root}/`, ROOT), {
    recursive: true,
    encoding: 'utf8',
  })
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => `${root}/${entry}`);
}

// Whether a source calls `name`. The line that declares it is not a call of it, and neither is a
// doc block showing callers how to spell one.
function calls(name: string, text: string): boolean {
  const call = new RegExp(`\\b${name}\\(`);
  return text
    .split('\n')
    .some(
      (line) =>
        call.test(line) &&
        !line.startsWith('export function') &&
        !/^\s*(\*|\/\/|\/\*)/.test(line),
    );
}

function callersIn(roots: readonly string[], name: string): string[] {
  return roots
    .flatMap(sourcesUnder)
    .filter((file) => calls(name, readFileSync(new URL(file, ROOT), 'utf8')))
    .sort();
}

// Lab files calling `name(`, as paths under src/. The readers are all lab-side.
function callersOf(name: string): string[] {
  return callersIn(['src'], name).map((file) => file.slice('src/'.length));
}

// Whether a source hands the raw walk something spelled like an Operation. The file roster catches
// a walk call arriving in a new file; this catches one arriving inside a file already admitted to
// call the walk for something else.
function walksAnOperation(text: string): boolean {
  return text.split('\n').some((line) => {
    const applied = /\bencodeAmounts\(([^)\n]*)/.exec(line);
    return (
      applied !== null &&
      /operation/i.test(applied[1]!) &&
      !/^\s*(\*|\/\/|\/\*)/.test(line)
    );
  });
}

// The lenient decoder takes spellings its own encoder never writes, so a reader of text this
// system stored must not call it directly. These two do not read stored text.
const LENIENT_CALLERS: Record<string, string> = {
  'money.ts':
    'holds the strict decoder and the Operation walk that guards on top of it',
  'webhooks.ts':
    "decodes a third-party provider's callback body, which encodeAmount never wrote",
};

// The readers of text this system wrote. Each one decodes through `decodeCanonicalAmount`.
const GUARDED_BOUNDARIES: Record<string, string> = {
  'adapters/http-wire.ts': 'the HTTP store adapter wire',
  'economy.ts': 'the read-through balance cache',
  'engines/sql-shared.ts': 'the SQL engines JSON columns',
  'wire-contract.ts':
    'the stored Operation, whose amount fields the field table names',
};

// The call sites that write a stored Operation, one per transport. Every one of them calls
// `encodeOperation`, so the column has one spelling; a fourth writer is a decision taken here.
const OPERATION_WRITERS: Record<string, string> = {
  'packages/mysql/src/mysql.ts': 'the MySQL engine inbox insert',
  'packages/postgres/src/postgres.ts': 'the Postgres engine inbox insert',
  'src/adapters/http-wire.ts': 'the HTTP store adapter wire',
};

// Who can reach the raw walk. It takes any value and never sees the key it is encoding, so a
// writer reaching it directly is how a second spelling of a stored column starts.
const WALK_CALLERS: Record<string, string> = {
  'src/money.ts': 'the walk recursing into its own object branch',
  'src/server.ts':
    'response bodies, which carry amounts and never a stored Operation',
  'src/wire-contract.ts': 'encodeOperation, the one writer of the inbox column',
};

// The one file allowed to apply the walk to an Operation.
const OPERATION_WALKERS = ['src/wire-contract.ts'];

const inboxRow = (operation: unknown): Record<string, unknown> => ({
  id: 'ibx_boundary',
  key: 'evt_boundary',
  operation,
  status: 'pending',
  attempts: 0,
  received_at: 1,
  dead_letter_reason: null,
});

const inboxMessage = (operation: Operation): InboxMessage => ({
  id: 'ibx_boundary',
  key: 'evt_boundary',
  operation,
  status: 'pending',
  attempts: 0,
  receivedAt: 1,
  reason: null,
});

describe('Amounts Read Back Are Refused Unless They Are Canonical', () => {
  test('the balance cache refuses a planted non-canonical entry', async () => {
    const economy = createEconomy({
      ...memoryPorts({ signingKey: 'amount-boundaries' }),
      logger: testLogger(),
      cache: plantedCache(NON_CANONICAL),
    });
    await assert.rejects(
      () => economy.read.balance(spendable('usr_boundary')),
      refusal,
    );
  });

  test('every HTTP store decoder refuses a non-canonical amount', () => {
    assert.deepEqual(
      WIRE_DECODERS.map(([name]) => name).sort(),
      Object.keys(decodeWire).sort(),
      'every decodeWire member decodes an amount; a new one needs a row here',
    );
    for (const [name, payload] of WIRE_DECODERS) {
      assert.throws(
        () => (decodeWire[name] as (wire: unknown) => unknown)(payload),
        refusal,
        name,
      );
    }
  });

  test('the Operation walk refuses a non-canonical amount', () => {
    assert.throws(
      () => decodeAmounts({ kind: 'topUp', amount: NON_CANONICAL }),
      refusal,
    );
  });

  test('the Operation walk still passes a colon-carrying non-amount through', () => {
    assert.deepEqual(
      decodeAmounts({
        sku: 'sku:premium',
        idempotencyKey: 'idem_boundary',
        amount: 'CREDIT:600.00',
      }),
      {
        sku: 'sku:premium',
        idempotencyKey: 'idem_boundary',
        amount: toAmount('CREDIT', 60_000n),
      },
    );
  });

  test('the SQL JSON columns refuse a non-canonical leg amount', () => {
    assert.throws(() => decodeLegs([WIRE_LEG]), refusal);
  });

  // The store wire carries the same Operation the SQL column holds, so it decodes through the
  // same field table: `sku` is text there whatever it is spelled like, and `price` is money.
  test('the store wire hands a string field back as the text it sent', () => {
    const price = toAmount('CREDIT', 40_000n);
    const sent = encodeWire.inboxMessage({
      id: 'ibx_boundary',
      key: 'evt_boundary',
      operation: {
        kind: 'spend',
        idempotencyKey: 'idem_boundary',
        actor: { kind: 'system', service: 'test' },
        orderId: 'ord_boundary',
        buyerId: 'usr_boundary',
        sku: 'CREDIT:12.34',
        price,
        recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      },
      status: 'pending',
      attempts: 0,
      receivedAt: 1,
      reason: null,
    });
    const back = decodeWire.inboxMessage(JSON.parse(JSON.stringify(sent)))
      .operation as Extract<Operation, { kind: 'spend' }>;
    assert.strictEqual(back.sku, 'CREDIT:12.34');
    assert.deepStrictEqual(back.price, price);
  });

  test('only money.ts and the one external boundary call the lenient decoder', () => {
    assert.deepEqual(
      callersOf('decodeAmountWire'),
      Object.keys(LENIENT_CALLERS).sort(),
    );
  });

  test('the guarded boundaries are exactly the readers of stored text', () => {
    assert.deepEqual(
      callersOf('decodeCanonicalAmount'),
      Object.keys(GUARDED_BOUNDARIES).sort(),
    );
  });

  // One column, two transports: the SQL engines write it and read it back with `rowToInbox`, the
  // HTTP store adapter writes and reads the same column over the wire. Each transport's reader is
  // driven over the other transport's bytes, so a host that swaps a SQL store for an HTTP one
  // reads the rows already in the inbox.
  test('a row either transport writes reads back through the other one', () => {
    let examined = 0;
    for (const kind of KINDS) {
      const operation = SAMPLES[kind];
      const sent = encodeWire.inboxMessage(inboxMessage(operation)) as {
        operation: unknown;
      };
      const overWire = JSON.stringify(sent.operation);
      const inColumn = JSON.stringify(encodeOperation(operation));
      assert.equal(
        overWire,
        inColumn,
        `${kind}: the two transports spell the column differently`,
      );
      assert.deepStrictEqual(
        rowToInbox(inboxRow(overWire)).operation,
        operation,
        `${kind}: the SQL reader cannot read what the wire wrote`,
      );
      assert.deepStrictEqual(
        decodeWire.inboxMessage({
          ...inboxMessage(operation),
          operation: JSON.parse(inColumn),
        }).operation,
        operation,
        `${kind}: the wire reader cannot read what the column holds`,
      );
      examined += 1;
    }
    assert.equal(examined, 14, `round-tripped ${examined} operation kinds`);
  });

  test('the inbox column is written from exactly three call sites', () => {
    assert.deepEqual(
      callersIn(SHIPPED_ROOTS, 'encodeOperation'),
      Object.keys(OPERATION_WRITERS).sort(),
    );
  });

  test('only the three files that state why can reach the raw walk', () => {
    assert.deepEqual(
      callersIn(SHIPPED_ROOTS, 'encodeAmounts'),
      Object.keys(WALK_CALLERS).sort(),
    );
  });

  test('only encodeOperation hands the raw walk an Operation', () => {
    assert.deepEqual(
      SHIPPED_ROOTS.flatMap(sourcesUnder)
        .filter((file) =>
          walksAnOperation(readFileSync(new URL(file, ROOT), 'utf8')),
        )
        .sort(),
      OPERATION_WALKERS,
    );
  });

  // The rosters above resolve from source, so a matcher that quietly stopped matching would report
  // a clean tree. The controls are a planted call of each name, the lines that carry a name
  // without calling it, and a file from each half of the walk the rosters are drawn from.
  test('the source scan finds a planted writer and skips the declaration', () => {
    assert.ok(calls('encodeAmounts', '  operation: encodeAmounts(entry.op),'));
    assert.ok(
      calls('encodeOperation', '  JSON.stringify(encodeOperation(x)),'),
    );
    assert.ok(
      !calls('encodeAmounts', 'export function encodeAmounts(v: unknown) {'),
    );
    assert.ok(
      !calls('encodeOperation', ' * JSON.stringify(encodeOperation(x))'),
    );
    assert.ok(walksAnOperation('  op: encodeAmounts(entry.operation),'));
    assert.ok(!walksAnOperation('  body: encodeAmounts(outcome.detail),'));
    assert.ok(!walksAnOperation(' * out = encodeAmounts(entry.operation)'));
    assert.equal(
      SHIPPED_ROOTS.length,
      19,
      `walked ${SHIPPED_ROOTS.length} source roots`,
    );
    const walked = SHIPPED_ROOTS.flatMap(sourcesUnder);
    for (const file of ['src/money.ts', 'packages/mysql/src/mysql.ts']) {
      assert.ok(walked.includes(file), `the scan never reached ${file}`);
    }
  });
});
