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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// The public surface the API reference must list in full. Regenerated intent: every symbol
// src/index.ts re-exports has a row on reference/api.mdx, so the page cannot silently fall behind
// the code. Update the page (not this list) when the surface changes.
const PUBLIC_EXPORTS = [
  'AccountRef',
  'Amount',
  'Anchor',
  'BitsetOptions',
  'Boot',
  'BootInit',
  'CONFIG_KEYS',
  'Cache',
  'CallOptions',
  'Checkpoint',
  'Clock',
  'Config',
  'Currency',
  'DECLINE_KEYS',
  'DEFAULT_SWEEP_LIMIT',
  'Digest',
  'Dispatcher',
  'ERROR_CODES',
  'Economy',
  'EconomyError',
  'EconomyEvent',
  'EconomyStatus',
  'EntitlementAttributes',
  'EnvDescription',
  'EnvMap',
  'ErrorCode',
  'FeePolicy',
  'FetchHandler',
  'HealthReport',
  'Ids',
  'Leg',
  'Logger',
  'Meter',
  'Operation',
  'Outcome',
  'Ports',
  'PortsInit',
  'Posting',
  'PreflightIssue',
  'Principal',
  'Processor',
  'ProvePorts',
  'ProveReport',
  'REJECTION_CODES',
  'REJECTION_SPEC',
  'Range',
  'Rate',
  'RateLimiter',
  'RateVerdict',
  'Rates',
  'RatesConfig',
  'Recipient',
  'Rejection',
  'RejectionCode',
  'RejectionDetail',
  'Runtime',
  'SCALE',
  'SECRET_KEYS',
  'SYSTEM',
  'Saga',
  'Scheduler',
  'Secrets',
  'ServerOptions',
  'ServerPorts',
  'Signer',
  'Statement',
  'Store',
  'StoredLink',
  'Success',
  'SweepRequest',
  'Transaction',
  'Worker',
  'WorkerDefaults',
  'add',
  'adjust',
  'allInvariantsHold',
  'boot',
  'cancelSubscription',
  'clawback',
  'compare',
  'convertCeil',
  'convertFloor',
  'createEconomy',
  'createServer',
  'createWorker',
  'credit',
  'credits',
  'currency',
  'debit',
  'decodeAmount',
  'decodeAmountWire',
  'defaultConfig',
  'describeEnv',
  'DEV_RATES',
  'earned',
  'findByHash',
  'encodeAmount',
  'grantEntitlement',
  'grantPromo',
  'idempotencyKey',
  'inspectConfig',
  'isAmount',
  'isNegative',
  'isRejection',
  'isSuccess',
  'isWalletAccount',
  'isZero',
  'loadConfig',
  'maintenanceWindow',
  'memoryPorts',
  'mergeConfig',
  'negate',
  'normalizeError',
  'openPorts',
  'paginate',
  'operatorActor',
  'ownerOf',
  'preflight',
  'promo',
  'proveEconomy',
  'refund',
  'requestPayout',
  'requireSuccess',
  'reverse',
  'reversePayout',
  'revokeEntitlement',
  'settlePayout',
  'spend',
  'spendable',
  'statusForError',
  'subscribe',
  'systemActor',
  'systemRuntime',
  'toAmount',
  'topUp',
  'usd',
  'userActor',
  'zero',
];

describe('the API reference lists the whole public surface', () => {
  const page = readFileSync(join(import.meta.dirname, 'content/economy/reference/api.mdx'), 'utf8');
  // Drop fenced code blocks first so their triple-backticks don't desync the inline-span scan.
  const inline = page.replace(/```[\s\S]*?```/g, '');
  const spans = new Set([...inline.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  for (const name of PUBLIC_EXPORTS) {
    test(`documents ${name}`, () => {
      expect(spans.has(name), `api.mdx has no code span for ${name}`).toBe(true);
    });
  }
});

describe('the hand-kept list covers the whole export surface', () => {
  // The other half of the guard: PUBLIC_EXPORTS itself must not fall behind the code. The barrel
  // is parsed textually — named re-export blocks plus the entry's own function and type
  // declarations, so this sees values and types both — rather than imported, which keeps the
  // library's sources out of this app's TypeScript program.
  test('every name src/index.ts exports appears in PUBLIC_EXPORTS', () => {
    const barrel = readFileSync(join(import.meta.dirname, '../../../src/index.ts'), 'utf8');
    const names = [...barrel.matchAll(/^export (?:type )?\{([\s\S]*?)\}/gm)]
      .flatMap((block) => (block[1] ?? '').split(','))
      .map((name) => name.replace(/^\s*type\s+/, '').trim())
      .filter(Boolean)
      .map((name) => name.split(' as ').pop()?.trim() ?? name)
      .concat(
        [
          ...barrel.matchAll(
            /^export (?:async )?(?:function|const|class|type|interface) ([A-Za-z0-9_]+)/gm,
          ),
        ].map((decl) => decl[1] ?? ''),
      );
    expect(names.length).toBeGreaterThan(100);
    const listed = new Set(PUBLIC_EXPORTS);
    const missing = names.filter((name) => !listed.has(name));
    expect(missing, 'add these exports to PUBLIC_EXPORTS and api.mdx').toEqual([]);
  });
});
