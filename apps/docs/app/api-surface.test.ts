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
  'AccountKind',
  'AccountRef',
  'Amount',
  'BitsetOptions',
  'Cache',
  'Capabilities',
  'Checkpoint',
  'Clock',
  'ComposedWorker',
  'Config',
  'Currency',
  'Digest',
  'Dispatcher',
  'DisputeEvent',
  'ERROR_CODES',
  'Economy',
  'EconomyError',
  'EconomyEvent',
  'EconomyOptions',
  'EconomyStatus',
  'EntitlementAttrs',
  'EnvMap',
  'ErrorCode',
  'ExternalPorts',
  'Externals',
  'FeePolicy',
  'GENESIS',
  'GENESIS_HEX',
  'Ids',
  'Leg',
  'Logger',
  'Meter',
  'MovementOutcome',
  'MovementRequest',
  'Operation',
  'Options',
  'Outcome',
  'PayoutFailedEvent',
  'PayoutSettledEvent',
  'Posting',
  'Principal',
  'Processor',
  'ProveReport',
  'PurchaseEvent',
  'Range',
  'Rate',
  'Rates',
  'Recipient',
  'RejectionCode',
  'RejectionDetail',
  'Reservations',
  'RuntimeDefaults',
  'SCALE',
  'SYSTEM',
  'Saga',
  'Selection',
  'SessionOptions',
  'SettleReport',
  'Signer',
  'Statement',
  'Store',
  'StoredLink',
  'SweepBatch',
  'SweepInput',
  'SweepName',
  'SweepResult',
  'SweepRun',
  'Transaction',
  'VELOCITY_CURRENCY',
  'WebhookAck',
  'WebhookEvent',
  'Worker',
  'WorkerCtx',
  'add',
  'adjust',
  'balanceDelta',
  'baseOf',
  'byCodeUnit',
  'cachedEntitlements',
  'cancelSubscription',
  'capabilitiesFromEnv',
  'chainHash',
  'checkEnv',
  'clawback',
  'compare',
  'compose',
  'composeWorker',
  'configuredRates',
  'convertCeil',
  'convertFloor',
  'createEconomy',
  'createReservations',
  'createServer',
  'createWorker',
  'credit',
  'currency',
  'debit',
  'decodeAmount',
  'decodeAmounts',
  'decodeAmountWire',
  'decodeWebhookEvent',
  'defaultConfig',
  'describeSelection',
  'drainInbox',
  'earned',
  'economyFromCapabilities',
  'encodeAmount',
  'encodeAmounts',
  'externalsFromEnv',
  'flatFee',
  'fromHex',
  'grantEntitlement',
  'grantPromo',
  'handlePurchaseWebhook',
  'handleWebhook',
  'instanceSession',
  'isAmount',
  'isNegative',
  'isWalletAccount',
  'isZero',
  'jsonlLogger',
  'loadConfig',
  'memoryCache',
  'memoryProcessor',
  'memoryStore',
  'metaNumber',
  'metaString',
  'neg',
  'noopLogger',
  'noopMeter',
  'normalizeError',
  'operatorActor',
  'ownerOf',
  'promo',
  'proveEconomy',
  'recoverSession',
  'refund',
  'relayOutbox',
  'requestPayout',
  'reverse',
  'reversePayout',
  'revokeEntitlement',
  'settlePayout',
  'signingPublicKeyHex',
  'spend',
  'spendable',
  'statusForError',
  'subscribe',
  'systemActor',
  'systemDigest',
  'systemSigner',
  'toAmount',
  'toHex',
  'toOperation',
  'topUp',
  'userActor',
  'walletKindOf',
  'workerCtxFrom',
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
  // is parsed textually (every statement is a named re-export block, so this sees values and
  // types both) rather than imported, which keeps the library's sources out of this app's
  // TypeScript program.
  test('every name src/index.ts exports appears in PUBLIC_EXPORTS', () => {
    const barrel = readFileSync(join(import.meta.dirname, '../../../src/index.ts'), 'utf8');
    const names = [...barrel.matchAll(/^export (?:type )?\{([\s\S]*?)\}/gm)]
      .flatMap((block) => (block[1] ?? '').split(','))
      .map((name) => name.replace(/^\s*type\s+/, '').trim())
      .filter(Boolean)
      .map((name) => name.split(' as ').pop()?.trim() ?? name);
    expect(names.length).toBeGreaterThan(100);
    const listed = new Set(PUBLIC_EXPORTS);
    const missing = names.filter((name) => !listed.has(name));
    expect(missing, 'add these exports to PUBLIC_EXPORTS and api.mdx').toEqual([]);
  });
});
