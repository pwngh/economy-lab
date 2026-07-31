/// <reference types="node" />
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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CHAIN_CONTINUITY_MARKER,
  CHAIN_FORK_INDEX,
  ENGINE_METRICS,
  SCHEMA_VERSION,
  encodeOperation,
  rowToInbox,
} from '#src/sql-kit.ts';
import { OPERATION_FIELDS, decodeStoredOperation } from '#src/wire-contract.ts';
import { toAmount } from '#src/money.ts';
import {
  COMMON,
  KINDS,
  SAMPLES,
  SAMPLE_ACTOR,
  SAMPLE_KEY,
  declaredFields,
} from '#test/support/operation-samples.ts';

import type { Operation } from '#src/contract.ts';

// Each schema file may live in the lab's own db/ or in the backend package that owns it. The
// resolver throws when it finds neither, so a moved file fails loudly instead of quietly
// dropping the assertions below.
function schemaSql(...candidates: string[]): string {
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(`../${candidate}`, import.meta.url));
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error(
    `no schema file found at any of: ${candidates.join(', ')}. ` +
      'A schema moved without updating this guard.',
  );
}

const SCHEMAS = [
  {
    engine: 'postgres',
    sql: schemaSql(
      'packages/postgres/db/postgresql-schema.sql',
      'db/postgresql-schema.sql',
    ),
  },
  {
    engine: 'mysql',
    sql: schemaSql('packages/mysql/db/mysql-schema.sql', 'db/mysql-schema.sql'),
  },
];

// The retry predicates in both engines match these two strings against driver error text. The SQL
// that produces that text lives in the schema files. Drift between them is silent: the predicate
// returns false, the fork error escapes as a hard failure, and only a concurrency test under load
// would notice.
describe('the retry vocabulary matches the SQL that raises it', () => {
  for (const { engine, sql } of SCHEMAS) {
    test(`${engine}: the schema names the chain-fork index CHAIN_FORK_INDEX matches`, () => {
      assert.ok(
        sql.includes(CHAIN_FORK_INDEX),
        `${engine} schema never names ${CHAIN_FORK_INDEX}, so the fork retry cannot fire`,
      );
    });

    test(`${engine}: the schema raises the chain-continuity message the predicate matches`, () => {
      assert.ok(
        sql.includes(CHAIN_CONTINUITY_MARKER),
        `${engine} schema never raises '${CHAIN_CONTINUITY_MARKER}', so the continuity retry cannot fire`,
      );
    });

    test(`${engine}: the schema seeds the schema version this build asserts`, () => {
      assert.ok(
        sql.includes(SCHEMA_VERSION),
        `${engine} schema never seeds version ${SCHEMA_VERSION}`,
      );
    });
  }
});

// The supervisor matches engine signals by name across a package boundary. Both sides read these constants,
// so a rename is a compile error rather than a detector that stops firing.
describe('the engine metric names are one shared list', () => {
  test('every name is namespaced under engine.', () => {
    for (const name of Object.values(ENGINE_METRICS)) {
      assert.ok(name.startsWith('engine.'), `${name} is not an engine signal`);
    }
  });

  test('the supervisor detectors read their names from the shared list', () => {
    const detect = readFileSync(
      fileURLToPath(new URL('../src/supervisor/detect.ts', import.meta.url)),
      'utf8',
    );
    for (const name of [
      ENGINE_METRICS.poolAcquire,
      ENGINE_METRICS.poolAcquireMs,
      ENGINE_METRICS.retry,
    ]) {
      assert.ok(
        !detect.includes(`'${name}'`),
        `src/supervisor/detect.ts hardcodes '${name}' instead of importing ENGINE_METRICS`,
      );
    }
  });
});

// The inbox `operation` column, both halves, with no database. `encodeOperation` and `rowToInbox`
// are the exact pair both engines call, so what runs here is the engines' codec and not a
// re-spelling of it. The live conformance leg covers one topUp and skips without a rig; this
// covers every arm of the union in a no-services run.
//
// SAMPLES, COMMON, KINDS and declaredFields are shared with the submit seam's shape gate
// (test/economy.validation.test.ts): one sample table, reconciled against OPERATION_FIELDS by both.

// The two shapes a driver hands back for a JSON column: MySQL returns the text, Postgres returns
// parsed jsonb. rowToInbox reads both, so both are driven.
const READ_SHAPES = [
  { driver: 'mysql (json text)', read: (json: string): unknown => json },
  {
    driver: 'postgres (parsed jsonb)',
    read: (json: string): unknown => JSON.parse(json),
  },
];

const inboxRow = (operation: unknown): Record<string, unknown> => ({
  id: 'ibx_codec_1',
  key: 'evt_codec_1',
  operation,
  status: 'pending',
  attempts: 0,
  received_at: 1_700_000_000_000,
  dead_letter_reason: null,
});

describe('the inbox operation codec round-trips without a database', () => {
  test('there is a sample for every kind the wire contract declares', () => {
    assert.deepEqual(Object.keys(SAMPLES).sort(), [...KINDS].sort());
    assert.equal(
      KINDS.length,
      14,
      `the contract declares ${KINDS.length} kinds`,
    );
  });

  test('every sample carries every field its kind declares', () => {
    let examined = 0;
    for (const kind of KINDS) {
      const declared = declaredFields(kind);
      const present = Object.keys(SAMPLES[kind]).filter(
        (field) => !COMMON.includes(field),
      );
      assert.deepEqual(
        present.sort(),
        [...declared].sort(),
        `${kind}: the sample and the wire contract disagree about its fields`,
      );
      examined += declared.length;
    }
    // An optional field left out of a sample is a field never round-tripped, so the total is
    // pinned rather than the per-kind lists alone.
    assert.equal(examined, 46, `examined ${examined} declared fields`);
  });

  for (const { driver, read } of READ_SHAPES) {
    for (const kind of KINDS) {
      test(`${driver}: ${kind} survives encode, stringify, parse, decode`, () => {
        const operation = SAMPLES[kind];
        const stored = JSON.stringify(encodeOperation(operation));
        const back = rowToInbox(inboxRow(read(stored)));
        assert.deepStrictEqual(back.operation, operation);
      });
    }
  }

  // What the encode step is for: JSON.stringify throws on the bigint inside a branded Amount, so
  // an un-encoded amount-bearing operation cannot be stored at all.
  test('an amount-bearing operation is not JSON-serializable until it is encoded', () => {
    const bearing = KINDS.filter((kind) =>
      Object.values(OPERATION_FIELDS[kind] as Record<string, string>).some(
        (spec) => spec.startsWith('amount'),
      ),
    );
    assert.equal(bearing.length, 8, `${bearing.length} kinds carry an amount`);
    for (const kind of bearing) {
      assert.throws(
        () => JSON.stringify(SAMPLES[kind]),
        TypeError,
        `${kind} stringifies with a raw Amount, so this no longer pins anything`,
      );
      assert.equal(
        typeof JSON.stringify(encodeOperation(SAMPLES[kind])),
        'string',
      );
    }
  });

  // Text a caller can put in any field, spelled exactly the way an amount is written.
  const AMOUNT_SHAPED = 'CREDIT:12.34';
  const AMOUNT_SHAPED_VALUE = toAmount('CREDIT', 1_234n);

  // A spelling encodeAmount never writes. It parses, so the walk read it as an amount and refused
  // it as non-canonical; in a field the table types `string` it is not an amount at all.
  const NOT_CANONICAL = 'CREDIT:60000';

  // Which fields decode is settled by the table rather than by the shape of the value, and the
  // classification is read off what the decoder DID: every declared field is stored as the same
  // amount-shaped text, and the ones that came back branded must be exactly the ones declared
  // `amount`. A decoder that classified nothing hands back 46 strings and fails on the 8.
  test('the field table classifies every declared field, and only its amounts decode', () => {
    const declared: string[] = [];
    const branded: string[] = [];
    let classified = 0;
    for (const kind of KINDS) {
      const spec = OPERATION_FIELDS[kind] as Record<string, string>;
      const stored: Record<string, unknown> = {
        kind,
        idempotencyKey: SAMPLE_KEY,
        actor: SAMPLE_ACTOR,
      };
      for (const field of declaredFields(kind)) {
        stored[field] = AMOUNT_SHAPED;
        if (spec[field]!.startsWith('amount')) {
          declared.push(`${kind}.${field}`);
        }
      }
      const back = decodeStoredOperation(stored) as unknown as Record<
        string,
        unknown
      >;
      for (const field of declaredFields(kind)) {
        classified += 1;
        if (typeof back[field] === 'string') {
          assert.equal(back[field], AMOUNT_SHAPED, `${kind}.${field}`);
          continue;
        }
        assert.deepStrictEqual(
          back[field],
          AMOUNT_SHAPED_VALUE,
          `${kind}.${field} came back as neither an Amount nor its stored text`,
        );
        branded.push(`${kind}.${field}`);
      }
    }
    assert.equal(classified, 46, `classified ${classified} declared fields`);
    assert.deepEqual(branded, declared);
    assert.equal(
      declared.length,
      8,
      `the contract declares ${declared.length} amount fields`,
    );
  });

  // What this replaced: the walk that writes the column reads values and never keys, so decoding
  // with it re-branded any string that parsed as a wire amount, whatever field it sat in. The
  // price beside it is the control — the table's own amount still decodes.
  for (const { driver, read } of READ_SHAPES) {
    test(`${driver}: a string field spelled like a canonical amount stays a string`, () => {
      const operation = { ...SAMPLES.spend, sku: AMOUNT_SHAPED };
      const stored = JSON.stringify(encodeOperation(operation));
      const back = rowToInbox(inboxRow(read(stored))).operation as Extract<
        Operation,
        { kind: 'spend' }
      >;
      assert.strictEqual(back.sku, AMOUNT_SHAPED);
      assert.deepStrictEqual(back.price, SAMPLES.spend.price);
    });
  }

  // The table declares neither the three fields every kind carries nor anything nested inside a
  // field, so none of them is a candidate for decoding.
  test('the fields outside the table are handed back untouched', () => {
    const purchase = decodeStoredOperation({
      ...(encodeOperation(SAMPLES.spend) as Record<string, unknown>),
      idempotencyKey: AMOUNT_SHAPED,
      actor: { kind: 'system', service: AMOUNT_SHAPED },
      recipients: [{ sellerId: AMOUNT_SHAPED, shareBps: 10_000 }],
    }) as Extract<Operation, { kind: 'spend' }>;
    assert.strictEqual(purchase.idempotencyKey, AMOUNT_SHAPED);
    assert.strictEqual(
      (purchase.actor as { service: string }).service,
      AMOUNT_SHAPED,
    );
    assert.strictEqual(purchase.recipients[0]!.sellerId, AMOUNT_SHAPED);

    const grant = decodeStoredOperation({
      ...(encodeOperation(SAMPLES.grantEntitlement) as Record<string, unknown>),
      attrs: { source: AMOUNT_SHAPED, expiresAt: null },
    }) as Extract<Operation, { kind: 'grantEntitlement' }>;
    assert.strictEqual(grant.attrs?.source, AMOUNT_SHAPED);
  });

  // Reading one of these used to throw, which left the row unreadable and so undrainable: a
  // reader that cannot read the row cannot dead-letter it either, and the whole page it sits in
  // fails with it.
  for (const { driver, read } of READ_SHAPES) {
    test(`${driver}: text shaped like a non-canonical amount is read back, not refused`, () => {
      const operation = { ...SAMPLES.topUp, source: NOT_CANONICAL };
      const stored = JSON.stringify(encodeOperation(operation));
      const back = rowToInbox(inboxRow(read(stored))).operation as Extract<
        Operation,
        { kind: 'topUp' }
      >;
      assert.strictEqual(back.source, NOT_CANONICAL);
    });
  }

  test('a declared amount stored in another spelling is refused, named by field', () => {
    const stored = {
      ...(encodeOperation(SAMPLES.topUp) as Record<string, unknown>),
      amount: NOT_CANONICAL,
    };
    assert.throws(
      () => decodeStoredOperation(stored),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'MONEY.INVALID_AMOUNT');
        assert.ok(
          error.message.startsWith('Stored topUp.amount is not canonical'),
          error.message,
        );
        return true;
      },
    );
  });

  test('a kind this build does not declare passes through undecoded', () => {
    const unknown = 'rehearsePayout';
    assert.ok(
      !(unknown in OPERATION_FIELDS),
      `${unknown} is declared after all`,
    );
    const stored = {
      kind: unknown,
      idempotencyKey: SAMPLE_KEY,
      amount: AMOUNT_SHAPED,
    };
    assert.deepStrictEqual(
      decodeStoredOperation(stored) as unknown as Record<string, unknown>,
      stored,
    );
  });

  test('a column holding anything but a JSON object is refused', () => {
    for (const stored of [null, AMOUNT_SHAPED, 7, [AMOUNT_SHAPED]]) {
      assert.throws(
        () => decodeStoredOperation(stored),
        /must be a JSON object/,
        String(stored),
      );
    }
  });
});
