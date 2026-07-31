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

/**
 * The wire contract's stability gate: the generated OpenAPI matches the committed snapshot
 * byte for byte, and the route registry matches what the server actually serves.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildOpenApi,
  FIELDS,
  OPERATION_FIELDS,
  ROUTES,
} from '#src/wire-contract.ts';
import type { Spec } from '#src/wire-contract.ts';
import { REJECTION_CODES } from '#src/errors.ts';
import { createServer } from '#src/server.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { fixedClock, silentMeter } from '#src/runtime.ts';
import {
  fixedRates,
  testConfig,
  testLogger,
  testSecrets,
} from '#test/support/capabilities.ts';

describe('The Wire Contract Is Pinned', () => {
  test('the generated OpenAPI matches the committed snapshot byte for byte', () => {
    const snapshot = readFileSync(
      new URL('./fixtures/openapi.snapshot.json', import.meta.url),
      'utf8',
    );
    const generated = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
    assert.equal(
      generated,
      snapshot,
      'the contract changed — regenerate test/fixtures/openapi.snapshot.json deliberately',
    );
  });

  test('every operation kind has a field-table row and a schema; every rejection reason is in the spec', () => {
    const api = buildOpenApi() as {
      components: { schemas: Record<string, unknown> };
    };
    for (const kind of Object.keys(OPERATION_FIELDS)) {
      assert.ok(api.components.schemas[`Op_${kind}`], `schema for ${kind}`);
    }
    const outcome = JSON.stringify(api.components.schemas.Outcome);
    for (const code of REJECTION_CODES) {
      assert.ok(outcome.includes(code), `${code} named in the Outcome schema`);
    }
  });

  /**
   * The two tables differ by an exact roster, spelled out here rather than recomputed from the
   * list that builds it — a test that re-ran the filter would agree with any list at all. Every
   * name on it is a field only the server sets, so a row appearing here without a decision is a
   * field that silently left the published contract.
   */
  const SERVER_SET = ['reversePayout.providerReported'];

  test('the wire table is the complete table minus exactly the server-set fields', () => {
    const missing: string[] = [];
    let compared = 0;
    for (const [kind, rows] of Object.entries(OPERATION_FIELDS)) {
      const wire = FIELDS[kind as keyof typeof FIELDS] as Record<string, Spec>;
      for (const [field, spec] of Object.entries(
        rows as Record<string, Spec>,
      )) {
        compared += 1;
        if (!(field in wire)) {
          missing.push(`${kind}.${field}`);
          continue;
        }
        assert.equal(
          wire[field],
          spec,
          `${kind}.${field} has a different shape on the wire than on the Operation`,
        );
      }
    }
    assert.equal(compared, 46, `compared ${compared} declared fields`);
    assert.deepEqual(missing.sort(), [...SERVER_SET].sort());
  });

  test('a server-set field is published nowhere a caller can read it', () => {
    const document = JSON.stringify(buildOpenApi());
    let checked = 0;
    for (const entry of SERVER_SET) {
      const [kind, field] = entry.split('.') as [string, string];
      assert.ok(
        !document.includes(`"${field}"`),
        `${field} is still in the OpenAPI document, which is what generates the clients`,
      );
      assert.ok(
        field in
          (OPERATION_FIELDS[kind as keyof typeof OPERATION_FIELDS] as Record<
            string,
            Spec
          >),
        `${entry} is not on the Operation at all, so this roster is stale`,
      );
      checked += 1;
    }
    assert.equal(checked, SERVER_SET.length);
    assert.equal(checked, 1, `checked ${checked} server-set fields`);
  });

  test('the route registry matches the served table, mounted and unmounted alike', async () => {
    const ports = {
      config: testConfig(),
      secrets: testSecrets(),
      clock: fixedClock(0),
      meter: silentMeter(),
      logger: testLogger(),
      rates: fixedRates(),
    };
    const bare = createServer({
      economy: makeEconomy(),
      ports,
      authenticate: false,
    });
    const full = createServer({
      economy: makeEconomy(2),
      ports,
      authenticate: false,
      webhook: async () => new Response('ok'),
      instances: {
        laneFor: () => ({ purchase: async () => ({ status: 'accepted' }) }),
      } as never,
    });
    const noReads = createServer({
      economy: makeEconomy(3),
      ports,
      authenticate: false,
      reads: false,
    });
    for (const route of ROUTES) {
      if (route.path === '/v1/posting/{txnId}') {
        continue; // the 404 for an unknown txn is the contract; the reads test covers it
      }
      const path = route.path
        .replace('{provider}', 'p1')
        .replace('{scope}', 's1');
      const probe = (handler: typeof bare) =>
        handler(
          new Request(`http://t${path}`, {
            method: route.method,
            ...(route.method === 'POST'
              ? { body: '{}', headers: { 'content-type': 'application/json' } }
              : {}),
          }),
        );
      assert.notEqual(
        (await probe(full)).status,
        404,
        `${route.method} ${route.path} in the registry but 404s when fully mounted`,
      );
      if (route.when === 'reads') {
        assert.equal(
          (await probe(noReads)).status,
          404,
          `${route.method} ${route.path} rides \`reads\` but answers under reads: false`,
        );
      } else if (route.when !== undefined) {
        assert.equal(
          (await probe(bare)).status,
          404,
          `${route.method} ${route.path} is conditional on ${route.when} but answers bare`,
        );
      }
    }
  });
});
