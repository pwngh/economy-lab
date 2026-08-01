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

// The environment surface is enumerable: every family that reads env exports the key list it
// reads, and this test holds .env.example to the union — every declared name must be documented,
// and every documented name must belong to a declared family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import '#test/support/dist-guard.ts';

import {
  OPTIONAL_SECRETS,
  REQUIRED_SECRETS,
  SERVICE_URL_KEYS,
  STORE_URL_KEYS,
} from '#src/env.ts';
import {
  CONFIG_KEYS,
  DECLINE_KEYS,
  SECRET_KEYS,
  defaultConfig,
  inspectConfig,
} from '#src/config.ts';
import { hasCode } from '#test/support/capabilities.ts';
import { BENCH_KEYS } from '#test/support/harness.ts';
import {
  EXTERNALS_KEYS,
  SUPERVISOR_KEYS,
  SERVER_KEYS,
} from '#economy/lib/env-keys.ts';
import { TILIA_KEYS } from '#economy/lib/edge-host.ts';
import { TASKQ_KEYS } from '#economy/lib/taskq-host.ts';

// Names read by entry scripts that execute on import (so their lists can't live in the script):
// the two BENCH_QUEUE_* names are scripts/bench-queue.ts's (mirrored by its exported
// BENCH_QUEUE_KEYS, which this test can't import without running the script);
// BENCH_HOT_CONCURRENCY is scripts/bench-scale.ts's hot-seller depth sweep.
const SCRIPT_KEYS = [
  'BENCH_QUEUE',
  'BENCH_QUEUE_COOLDOWN_MS',
  'BENCH_HOT_CONCURRENCY',
] as const;

// Names .env.example documents that the lab never parses itself: the AWS SDK reads these from the
// environment directly (test/acceptance/smoke.test.ts seeds them for LocalStack).
const SDK_PASSTHROUGH = new Set([
  'AWS_REGION',
  'AWS_ENDPOINT_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
]);

const DECLARED = new Set<string>([
  ...STORE_URL_KEYS,
  ...SERVICE_URL_KEYS,
  ...REQUIRED_SECRETS,
  ...OPTIONAL_SECRETS,
  ...CONFIG_KEYS,
  ...SECRET_KEYS,
  ...DECLINE_KEYS,
  ...SERVER_KEYS,
  ...EXTERNALS_KEYS,
  ...BENCH_KEYS,
  ...TILIA_KEYS,
  ...TASKQ_KEYS,
  ...SUPERVISOR_KEYS,
  ...SCRIPT_KEYS,
]);

// Every `NAME=` at the start of a line, active or commented out, is a documented name.
function documentedNames(example: string): Set<string> {
  const names = new Set<string>();
  for (const line of example.split('\n')) {
    const match = /^#?\s?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) {
      names.add(match[1]!);
    }
  }
  return names;
}

test('.env.example documents exactly the declared env surface', async () => {
  const example = await readFile(
    new URL('../.env.example', import.meta.url),
    'utf8',
  );
  const documented = documentedNames(example);

  const undocumented = [...DECLARED]
    .filter((name) => !documented.has(name))
    .sort();
  assert.deepEqual(
    undocumented,
    [],
    `declared in code but missing from .env.example: ${undocumented.join(', ')}`,
  );

  const undeclared = [...documented]
    .filter((name) => !DECLARED.has(name) && !SDK_PASSTHROUGH.has(name))
    .sort();
  assert.deepEqual(
    undeclared,
    [],
    `documented in .env.example but no family declares it: ${undeclared.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// The configuration page, held to the same surface
// ---------------------------------------------------------------------------

/**
 * `reference/configuration.mdx` documents the deployment half of this surface as variable tables,
 * and it once stood four names short while its summary promised every variable. So the page is
 * held to the same {@link DECLARED} set `.env.example` is: every name it tables must belong to a
 * declared family, and every declared name must be a table row or sit on the stated roster below.
 * The split is asserted, not implied by omission — the page and the roster partition DECLARED.
 */
const CONFIGURATION_PAGE =
  'apps/docs/app/content/economy/reference/configuration.mdx';

/** Names the page deliberately does not table, each with the claim that keeps it off the page. */
const PAGE_EXEMPT: ReadonlyArray<{
  names: readonly string[];
  why: string;
}> = [
  {
    names: ['NODE_ENV'],
    why: 'the mode selector; the page names it in prose at the sections it splits, not as a knob row',
  },
  {
    names: ['PG_URL', 'MYSQL_TEST_URL'],
    why: 'tests/tools-only URL aliases; .env.example marks both as not deployment config',
  },
  {
    // Every Tilia name except the opt-in gate, which the page does table.
    names: [
      ...TILIA_KEYS.filter((key) => key !== 'TILIA_CLIENT_ID'),
      'TILIA_PAYEE_DATABASE_URL',
    ],
    why: 'the Tilia rail credentials belong to @pwngh/economy-edge and are documented at their parse (economy/lib/edge-host.ts); the page carries only the TILIA_CLIENT_ID gate',
  },
  {
    names: [...BENCH_KEYS, ...SCRIPT_KEYS],
    why: 'the bench harness dials; .env.example files them under "Lab tooling … not deployment config", documented at their parse (BENCH_KEYS in test/support/harness.ts)',
  },
];

/**
 * Every backticked `UPPER_SNAKE` name in the first cell of a `| Variable | … |` table. Rows only —
 * a name mentioned in a Meaning cell or in prose documents nothing by itself. The paired-rate rows
 * carry two names in one cell, so names can outnumber rows.
 */
function pageVariableNames(mdx: string): {
  tables: number;
  rows: number;
  names: Set<string>;
} {
  const lines = mdx.split('\n');
  let tables = 0;
  let rows = 0;
  const names = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!/^\|\s*Variable\s*\|/.test(lines[i]!)) continue;
    tables += 1;
    // Skip the header separator, then read rows until the table ends.
    for (let j = i + 2; j < lines.length && lines[j]!.startsWith('|'); j++) {
      rows += 1;
      const cell = lines[j]!.split('|')[1] ?? '';
      for (const m of cell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
        names.add(m[1]!);
      }
      i = j;
    }
  }
  return { tables, rows, names };
}

test('the parser reads variable-table rows and nothing else', () => {
  // The positive control on the matcher: known input, hand-written expectation. Without it the
  // page test below is satisfiable by a parser that quietly matches nothing (the counts would
  // catch that today, but this states which shapes count and which do not).
  const fixture = [
    '`PROSE_NAME` in prose documents nothing.',
    '',
    '| Variable | Meaning | Default |',
    '| --- | --- | --- |',
    '| `ALPHA_MS` | a knob | `1` |',
    '| `PAIR_RATE` / `PAIR_SCALE` | two names, one row | none |',
    '',
    '| Column | Meaning |',
    '| --- | --- |',
    '| `NOT_A_VARIABLE_TABLE` | ignored |',
  ].join('\n');
  const parsed = pageVariableNames(fixture);
  assert.equal(parsed.tables, 1);
  assert.equal(parsed.rows, 2);
  assert.deepEqual([...parsed.names].sort(), [
    'ALPHA_MS',
    'PAIR_RATE',
    'PAIR_SCALE',
  ]);
});

test('configuration.mdx tables exactly the deployment half of the declared surface', async () => {
  const page = pageVariableNames(await read(CONFIGURATION_PAGE));
  // Exact, not floors: a parser that stops seeing a table family would report a smaller page than
  // the one on disk and still find no mismatches.
  assert.equal(page.tables, 18);
  assert.equal(page.rows, 55);
  assert.equal(page.names.size, 58);

  const exempt = PAGE_EXEMPT.flatMap((row) => row.names);
  const exemptSet = new Set(exempt);
  assert.equal(exempt.length, exemptSet.size, 'a name is exempted twice');

  // A tabled name nobody reads: a typo'd, retired, or invented row.
  const undeclared = [...page.names]
    .filter((name) => !DECLARED.has(name))
    .sort();
  assert.deepEqual(
    undeclared,
    [],
    `the page tables a name no family declares: ${undeclared.join(', ')}`,
  );

  // The completeness the page claims: every declared name is a row or is exempted by name above.
  const missing = [...DECLARED]
    .filter((name) => !page.names.has(name) && !exemptSet.has(name))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `declared but neither tabled nor exempted: ${missing.join(', ')}`,
  );

  // Exemptions re-resolve. A name both tabled and exempted means the roster is stale; an exempt
  // name no family declares is residue; and the two reasons that assert page facts still hold —
  // the Tilia gate is tabled, and NODE_ENV appears in the prose the first row's reason points at.
  const stale = [...exemptSet].filter((name) => page.names.has(name)).sort();
  assert.deepEqual(stale, [], `exempted yet tabled: ${stale.join(', ')}`);
  const unread = exempt.filter((name) => !DECLARED.has(name)).sort();
  assert.deepEqual(unread, [], `exempted but undeclared: ${unread.join(', ')}`);
  assert.ok(page.names.has('TILIA_CLIENT_ID'));
  assert.ok((await read(CONFIGURATION_PAGE)).includes('NODE_ENV=production'));

  // The partition: tabled plus exempted is the whole declared surface, with no overlap.
  assert.equal(DECLARED.size, page.names.size + exemptSet.size);
});

// ---------------------------------------------------------------------------
// The webhook freshness window, at every site that names it
// ---------------------------------------------------------------------------

/**
 * `Config.replayWindowMs` / `REPLAY_WINDOW_MS` bounded a webhook timestamp that rides in a header
 * no signature covers, so the window never bounded replay. The knob is `freshnessWindowMs` /
 * `FRESHNESS_WINDOW_MS`, the spelling `@pwngh/economy-webhook` chose for the same window.
 *
 * A rename verified by "nothing greps for the old name" passes while examining nothing, so this
 * runs in both directions: the roster resolves every file that names the knob, and the scan holds
 * the tree to exactly that roster. The absence half carries a positive control, because a matcher
 * that stopped matching would report the tree clean.
 *
 * A typecheck already covers every `.ts` reference to the field. What it cannot see is the env name
 * in a string key, the name in an `.mdx` page, and the name in a README, which is where a rename
 * goes stale.
 */
const FRESHNESS_SPELLINGS = ['freshnessWindowMs', 'FRESHNESS_WINDOW_MS'];

const RETIRED_SPELLINGS = [
  'replayWindowMs',
  'REPLAY_WINDOW_MS',
  'DEFAULT_REPLAY_WINDOW_MS',
];

/** Every file that names the knob. Repository-relative, so the failure reads as a path. */
const FRESHNESS_SITES = [
  '.env.example',
  'CHANGELOG.md',
  'apps/console/app/demo.ts',
  'apps/docs/app/content/economy/ops/runbooks/webhook-replay-storm.mdx',
  'apps/docs/app/content/economy/reference/configuration.mdx',
  'apps/docs/app/content/economy/reference/http-service.mdx',
  'packages/cli/test/render.test.ts',
  'packages/core/README.md',
  'src/config.ts',
  'src/server.ts',
  'test/config.test.ts',
  'test/env-surface.test.ts',
  'test/server.test.ts',
  'test/support/capabilities.ts',
  'test/wiring.test.ts',
];

/**
 * `packages/webhook` declares its own `freshnessWindowMs` on `WebhookVerifierOptions`. The two
 * spell one concept alike on purpose, and that package pins its own roster and refuses anything
 * named after replay, so its files are not this roster's to hold. The retired-name scan below
 * still covers it.
 */
const OWNS_ITS_OWN = 'packages/webhook/';

/** Files that name a retired spelling deliberately, each re-resolved so a stale reason fails. */
const RETIRED_ADMITTED = [
  {
    path: 'src/config.ts',
    why: 'declares the retired name so preflight reports a deploy that still sets it',
  },
  {
    path: 'test/config.test.ts',
    why: 'asserts the retired name reaches no field',
  },
  {
    path: 'test/env-surface.test.ts',
    why: 'the matchers and the positive control here',
  },
  {
    path: 'CHANGELOG.md',
    why: 'the breaking entry names the spelling it replaced',
  },
];

const found = (text: string, spellings: readonly string[]): string[] =>
  spellings.filter((word) =>
    new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`).test(text),
  );

const SCAN_DIRS = ['src', 'test', 'apps', 'packages', 'scripts', 'economy'];
const SCAN_FILES = [
  '.env.example',
  '.env.compose',
  'CHANGELOG.md',
  'README.md',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
];
const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.mjs',
  '.js',
  '.json',
  '.md',
  '.mdx',
  '.yml',
  '.sh',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.react-router',
  '.wrangler',
  'runner',
]);

/** Every scannable file, repository-relative, grouped by the root it came from. */
async function scannable(): Promise<Map<string, string[]>> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const byRoot = new Map<string, string[]>();
  for (const dir of SCAN_DIRS) {
    const found: string[] = [];
    for (const entry of await readdir(join(root, dir), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const rel = relative(root, join(entry.parentPath, entry.name));
      if (rel.split('/').some((part) => SKIP_DIRS.has(part))) continue;
      if (entry.name === 'package-lock.json') continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0 || !SCAN_EXTENSIONS.has(entry.name.slice(dot))) continue;
      found.push(rel);
    }
    byRoot.set(dir, found);
  }
  byRoot.set('(root files)', [...SCAN_FILES]);
  return byRoot;
}

const read = async (rel: string): Promise<string> =>
  readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

test('every site that names the webhook freshness window names it the one way', async () => {
  let examined = 0;
  for (const site of FRESHNESS_SITES) {
    const names = found(await read(site), FRESHNESS_SPELLINGS);
    assert.ok(names.length > 0, `${site} names neither spelling of the knob`);
    examined += 1;
  }
  assert.equal(examined, FRESHNESS_SITES.length);
  assert.equal(examined, 15, `resolved ${examined} sites`);
});

test('the tree names the knob at exactly those sites, and nowhere by its retired name', async () => {
  const byRoot = await scannable();
  // Every declared root has to have yielded files, or the scan below reports on a smaller tree
  // than the one it claims to cover.
  assert.deepEqual(
    [...byRoot].filter(([, files]) => files.length === 0),
    [],
  );
  assert.equal(byRoot.size, SCAN_DIRS.length + 1);
  const files = [...byRoot.values()].flat();

  const naming: string[] = [];
  const retired: string[] = [];
  for (const rel of files) {
    const text = await read(rel);
    if (
      found(text, FRESHNESS_SPELLINGS).length > 0 &&
      !rel.startsWith(OWNS_ITS_OWN)
    ) {
      naming.push(rel);
    }
    if (found(text, RETIRED_SPELLINGS).length > 0) retired.push(rel);
  }

  assert.deepEqual(naming.sort(), [...FRESHNESS_SITES].sort());

  const admitted = new Set(RETIRED_ADMITTED.map((row) => row.path));
  assert.deepEqual(
    retired.filter((rel) => !admitted.has(rel)).sort(),
    [],
    'a file names the retired spelling and is not admitted above',
  );
  // The other direction: an admission whose file no longer names it is residue, not an admission.
  for (const row of RETIRED_ADMITTED) {
    assert.ok(
      retired.includes(row.path),
      `${row.path} is admitted for "${row.why}" and does not name a retired spelling`,
    );
  }
  assert.equal(retired.length, RETIRED_ADMITTED.length);
});

test('the matcher fires on the retired spellings and not on the supervisor knob', () => {
  // Without this the absence assertion above is satisfied by a matcher that matches nothing.
  assert.deepEqual(
    found(
      'replayWindowMs REPLAY_WINDOW_MS DEFAULT_REPLAY_WINDOW_MS',
      RETIRED_SPELLINGS,
    ),
    RETIRED_SPELLINGS,
  );
  // `webhookReplayWindowMs` is the supervisor's storm-detector window. It aggregates duplicate
  // counts, so it is named for what it measures and is not part of this rename.
  assert.deepEqual(found('webhookReplayWindowMs', RETIRED_SPELLINGS), []);
  assert.deepEqual(found('freshnessWindowMsX', FRESHNESS_SPELLINGS), []);
});

// ---------------------------------------------------------------------------
// The names the code reads, in both directions
// ---------------------------------------------------------------------------

/**
 * `CONFIG_KEYS` is the roster `.env.example` is held to above, and until now nothing held it to a
 * reader. A name left on it after `buildConfig` stopped reading it stays documented and stays
 * green: the value an operator sets reaches no field, and every gate agrees the surface is intact.
 * That is the half-rename `REPLAY_WINDOW_MS` could have shipped as.
 *
 * So each name is driven through {@link inspectConfig} on a value chosen to differ from the
 * default, and the resolved `Config` has to move — at the field named here, written out rather
 * than read off the table the resolver reads. A probe that only asserted *something* moved would
 * pass on a name wired into the wrong knob.
 */
const PARSED: ReadonlyArray<{
  name: string;
  value: string;
  field: string;
}> = [
  { name: 'FRESHNESS_WINDOW_MS', value: '90000', field: 'freshnessWindowMs' },
  { name: 'MAX_PAYOUT_ATTEMPTS', value: '7', field: 'maxPayoutAttempts' },
  { name: 'MAX_OUTBOX_ATTEMPTS', value: '11', field: 'maxOutboxAttempts' },
  { name: 'MAX_INBOX_ATTEMPTS', value: '12', field: 'maxInboxAttempts' },
  {
    name: 'MAX_SUBSCRIPTION_ATTEMPTS',
    value: '13',
    field: 'maxSubscriptionAttempts',
  },
  { name: 'MAX_PAYOUT_AGE_MS', value: '90000000', field: 'maxPayoutAgeMs' },
  { name: 'PLATFORM_FEE_BPS', value: '2500', field: 'platformFeeBps' },
  { name: 'PAYOUT_FEE_BPS', value: '175', field: 'payoutFeeBps' },
  {
    name: 'VELOCITY_LIMIT_MINOR',
    value: '250000',
    field: 'velocityLimitMinor',
  },
  {
    name: 'VELOCITY_INFLOW_LIMIT_MINOR',
    value: '150000',
    field: 'velocityInflowLimitMinor',
  },
  {
    name: 'VELOCITY_OUTFLOW_LIMIT_MINOR',
    value: '175000',
    field: 'velocityOutflowLimitMinor',
  },
  { name: 'VELOCITY_WINDOW_MS', value: '900000', field: 'velocityWindowMs' },
  {
    name: 'SUBSCRIPTION_PRICE_MIN_MINOR',
    value: '20000',
    field: 'subscriptionPriceMinMinor',
  },
  {
    name: 'SUBSCRIPTION_PRICE_MAX_MINOR',
    value: '2000000',
    field: 'subscriptionPriceMaxMinor',
  },
  {
    name: 'TOP_UP_BUNDLES_MINOR',
    value: '1200,12000',
    field: 'topUpBundlesMinor',
  },
  // The five horizons land in one record, and the four rails default to the card anchor, so each
  // of them moves the same field.
  {
    name: 'MATURITY_HORIZON_CARD_MS',
    value: '604800000',
    field: 'maturityHorizonMs',
  },
  {
    name: 'MATURITY_HORIZON_CRYPTO_MS',
    value: '3600000',
    field: 'maturityHorizonMs',
  },
  {
    name: 'MATURITY_HORIZON_STEAM_MS',
    value: '7200000',
    field: 'maturityHorizonMs',
  },
  {
    name: 'MATURITY_HORIZON_META_MS',
    value: '10800000',
    field: 'maturityHorizonMs',
  },
  {
    name: 'MATURITY_HORIZON_DEFAULT_MS',
    value: '14400000',
    field: 'maturityHorizonMs',
  },
  { name: 'SLA_PENDING_MS', value: '45000', field: 'payoutSla' },
  { name: 'SLA_SUBMITTED_MS', value: '150000', field: 'payoutSla' },
  { name: 'SLA_DEFAULT_MS', value: '75000', field: 'payoutSla' },
  {
    name: 'PAYOUT_MIN_EARNED_MINOR',
    value: '3000000',
    field: 'payoutMinimumEarnedMinor',
  },
  {
    name: 'PAYOUT_MIN_INTERVAL_MS',
    value: '43200000',
    field: 'payoutMinIntervalMs',
  },
  { name: 'ECONOMY_PAUSE_START_MS', value: '1000', field: 'pauseStartMs' },
  { name: 'ECONOMY_PAUSE_END_MS', value: '2000', field: 'pauseEndMs' },
  { name: 'PLATFORM_SHARDS', value: '4', field: 'platformShards' },
  { name: 'ACCRUAL_DRAIN', value: '1', field: 'accrualDrain' },
  { name: 'DB_POOL_MAX', value: '20', field: 'dbPoolMax' },
  {
    name: 'DB_CONNECT_TIMEOUT_MS',
    value: '10000',
    field: 'dbConnectTimeoutMs',
  },
];

/** The one name on the roster that reaches no field, with what it does reach instead. */
const UNPARSED: ReadonlyArray<{ name: string; why: string }> = [
  {
    name: 'NODE_ENV',
    why: 'the posture selector: it reaches no knob, and it decides whether the two policy anchors are demanded at all',
  },
];

const knobsMoved = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => !isDeepStrictEqual(before[field], after[field]))
    .sort();

test('every name CONFIG_KEYS publishes reaches a field of the resolved Config', () => {
  const base = inspectConfig({}) as unknown as Record<string, unknown>;
  // The baseline is the documented default, so a probe moves a value a deployment that set
  // nothing would have run on.
  assert.deepEqual(base, defaultConfig() as unknown as Record<string, unknown>);

  const examined: string[] = [];
  for (const { name, value, field } of PARSED) {
    const probed = inspectConfig({
      [name]: value,
    }) as unknown as Record<string, unknown>;
    const moved = knobsMoved(base, probed);
    assert.deepEqual(
      moved,
      [field],
      `${name}=${value} moved ${moved.length === 0 ? 'nothing' : moved.join(', ')}`,
    );
    examined.push(name);
  }
  // The roster before the count, so a knob with no probe is named rather than reported as one
  // fewer of something. Both lists are held to the published one, so a knob added to the table
  // arrives with a probe or with a stated reason it has none, never with neither.
  assert.deepEqual(
    [...examined, ...UNPARSED.map((row) => row.name)].sort(),
    [...CONFIG_KEYS].sort(),
  );
  assert.equal(examined.length, 31);
  assert.equal(CONFIG_KEYS.length, 32);
});

test('the one name that reaches no field is the mode selector, and it is still read', () => {
  assert.deepEqual(
    UNPARSED.map((row) => row.name),
    ['NODE_ENV'],
  );
  // Named rather than skipped: it moves no knob in either mode.
  assert.deepEqual(
    inspectConfig({ NODE_ENV: 'development' }),
    inspectConfig({}),
  );
  // And read all the same. The same call that resolves clean without it refuses with it, because
  // production is the posture that demands the two policy anchors.
  assert.throws(
    () => inspectConfig({ NODE_ENV: 'production' }),
    hasCode('CONFIG.INVALID'),
  );
});

/**
 * The other direction, and the one `.env.example` cannot see: a name the code reads that no family
 * declares is a knob with no documented variable and no row in any gate.
 *
 * The population is every file an `EnvMap` reaches, resolved from disk rather than listed, so a
 * fifth reader is scanned the run it is written. A file the bag reaches and no name comes out of
 * is admitted by name — it passes the bag on rather than reading it.
 */
const ENV_READER_ROOTS = ['src', 'economy'];

const READS_ENV = /\benv\.([A-Z][A-Z0-9_]*)\b/g;

const PASSES_THE_BAG: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: 'economy/lib/store-host.ts',
    why: 'it asks describeEnv which engine DATABASE_URL names rather than reading a name itself',
  },
];

/**
 * Every file under the declared roots that an EnvMap reaches, repository-relative, with the file
 * kinds the walk saw. Nothing is filtered by extension: a walk that skips a kind is blind to it
 * silently, so the census is asserted instead and a kind nobody has decided about fails here.
 */
async function envReaderFiles(): Promise<{
  readers: string[];
  extensions: string[];
}> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const readers: string[] = [];
  const extensions = new Set<string>();
  for (const dir of ENV_READER_ROOTS) {
    for (const entry of await readdir(join(root, dir), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      extensions.add(entry.name.slice(entry.name.lastIndexOf('.')));
      const rel = relative(root, join(entry.parentPath, entry.name));
      if (found(await read(rel), ['EnvMap']).length > 0) readers.push(rel);
    }
  }
  return { readers: readers.sort(), extensions: [...extensions].sort() };
}

test('the env-read matcher reads a property access and nothing else', () => {
  // Without this the scan below reports a clean tree by matching nothing.
  const fixture = [
    'const fee = env.PLATFORM_FEE_BPS;',
    'const db = process.env.DATABASE_URL;',
    'const code = ERROR_CODES.CONFIG_INVALID;',
    'const own = myenv.NOT_A_READ;',
    'const lower = env.notAName;',
  ].join('\n');
  assert.deepEqual(
    [...fixture.matchAll(READS_ENV)].map((match) => match[1]).sort(),
    ['DATABASE_URL', 'PLATFORM_FEE_BPS'],
  );
});

test('every env name the code reads is a name some family declares', async () => {
  const { readers, extensions } = await envReaderFiles();
  assert.deepEqual(extensions, ['.ts']);
  assert.deepEqual(readers, [
    'economy/lib/edge-host.ts',
    'economy/lib/host.ts',
    'economy/lib/store-host.ts',
    'economy/lib/taskq-host.ts',
    'src/config.ts',
    'src/env.ts',
    'src/from-env.ts',
    'src/index.ts',
  ]);

  const byFile = new Map<string, string[]>();
  for (const rel of readers) {
    const names = new Set<string>();
    for (const match of (await read(rel)).matchAll(READS_ENV)) {
      names.add(match[1]!);
    }
    byFile.set(rel, [...names].sort());
  }

  // A reader that yielded nothing is a file the scan says nothing about, so it is admitted by
  // name or it is a reader the matcher stopped seeing.
  const silent = [...byFile]
    .filter(([, names]) => names.length === 0)
    .map(([rel]) => rel);
  assert.deepEqual(silent, PASSES_THE_BAG.map((row) => row.path).sort());

  const namesRead = [...new Set([...byFile.values()].flat())].sort();
  const undeclared = namesRead.filter((name) => !DECLARED.has(name));
  assert.deepEqual(
    undeclared,
    [],
    `read by the code but no family declares it: ${undeclared.join(', ')}`,
  );
  // The population, after the names, so a scan that quietly shrank is caught by something other
  // than finding nothing wrong with what is left of it.
  assert.equal(namesRead.length, 58, namesRead.join(', '));

  // And the half CONFIG_KEYS is about: the config resolver reads its own names and no others.
  const policy = new Set(byFile.get('src/config.ts') ?? []);
  const strays = [...policy].filter(
    (name) =>
      !(CONFIG_KEYS as readonly string[]).includes(name) &&
      !(SECRET_KEYS as readonly string[]).includes(name),
  );
  assert.deepEqual(
    strays,
    [],
    `src/config.ts reads a name neither CONFIG_KEYS nor SECRET_KEYS publishes: ${strays.join(', ')}`,
  );
  assert.equal(policy.size, 34);
});
