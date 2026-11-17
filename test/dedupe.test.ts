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
 * The dedupe gate: a package never re-implements what the lab already computes.
 *
 * Three channels, because no one of them sees all of it. Same-name matching finds a copy that
 * kept its name — it matched every fork known when this was built, including three hex encoders
 * that share almost no text. Near-match scoring finds a copy whose author renamed it. Duplicated
 * values find a regex written out twice, which shares no function at all. Hashing a normalised
 * token stream, the instrument this was expected to be, matched none of the eight and is not
 * used: it survives only as the top of the near-match range.
 *
 * Every roster below is exact. A group that grows a member, or a new group of any kind, fails
 * here and is either fixed or admitted deliberately with a reason.
 *
 * ---
 *
 * SCOPE, BECAUSE THE THREE CHANNELS DO NOT COVER THE SAME GROUND AND A GREEN RUN HERE HAS BEEN
 * READ AS COVERING MORE THAN IT DOES.
 *
 * The walk reads four trees: `src/` and `packages/<pkg>/src` are shipped, `test/` and `scripts/`
 * and their per-package equivalents are rigs. Which channel reads which was decided by
 * measurement — 2026-07-30 for the walk, 2026-07-31 for the rest (`Q164`/`Q165`) — not by
 * preference.
 *
 * - **Near-match runs over all four, on two instruments.** A shipped pair is scored with literals
 *   collapsed, which is what lets the engine twins match through their driver names. In a rig
 *   that erasure inverts — a fixture builder is mostly literals, so two builders sharing only a
 *   shape scored 1.000 and each needed its own admission row. Rig-involved pairs are now scored
 *   with literals kept at `DICE_THRESHOLD_RIG`: the four shape-not-copy admissions measured
 *   0.235–0.500 kept and left the roster, the real rig forks measure 0.537–0.914 and stayed, and
 *   the re-measured instrument surfaced four pairs the old one scored below its line. A new
 *   fixture builder of a shared shape no longer arrives here at all; a verbatim copy of one still
 *   does, because copied literals are exactly what the kept stream sees.
 * - **Same-name runs over the shipped trees only, measured twice.** Widening was rejected
 *   2026-07-30 (21 → 60 groups, `fund` declared in sixteen files) and re-measured 2026-07-31
 *   against the narrower rule "a rig declares a name another scope ships": 23 groups, and read
 *   one by one they are generic-name coincidence — `call`, `get`, `walk`, `sleep`, a bench
 *   `resolveConfig` against a worker-knob `resolveConfig` — one sentence twenty-three times, the
 *   pattern admission the rosters refuse. The signal that separates a rig fork from a rig doing
 *   rig things is the body, and the body is the near-match channel's instrument; of the three
 *   real rig name-twins it found, `fakeCounter` and `fakeRedis` are filed through it below and
 *   `installSecondCopy` was extracted to `test/support/second-copy.ts`. **A rig fork that shares
 *   neither body nor a shipped file's literal is caught by reading or not at all.**
 * - **Duplicated-values runs over every group a shipped file takes part in.** The discriminator
 *   between a shared invariant and a shared fixture literal is whether a shipped file also states
 *   the text (`Q164`): measured 2026-07-31, that admits seven groups — each with its own reason
 *   below — while `'usr_seller'` in seven rig files stays out. A literal shared only among rigs
 *   is not gated; the known duplicated rig invariants are held by exact text in `RIG_INVARIANTS`,
 *   which is a record, not a detector — a new one is caught by reading.
 *
 * WHAT NO CHANNEL SEES, at any scope: a rule smaller than a function body. All three compare
 * declarations, so a one-line invariant stated as an inline expression in one file and as an
 * expression in another matches none of them. Measured: `Q122` added a second copy of the lab's
 * base-URL join to `packages/ui/src/`, both files inside this gate's scope, and every channel
 * stayed green. Both forks the tree grew in the week to 2026-07-30 were that shape, and both were
 * exported to one home by `Q89` and `Q127`. `LAB_OWNED_RULES` now holds each rule's single
 * statement and the consumers that import it; it still does not find a third one, and a copy
 * rewritten into different text is outside it as well.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// Named rather than taken off the global, which the toolchain declares with one parameter.
import { TextDecoder } from 'node:util';

import {
  MIN_TOKENS,
  duplicatedValues,
  keyOf,
  nearMatches,
  sameName,
  sourceFiles,
  thresholdFor,
  walkSources,
} from '#test/support/dedupe.ts';
import type { NameGroup, ValueGroup, Walk } from '#test/support/dedupe.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const walk: Walk = await walkSources(ROOT);
const shippedUnits = walk.units.filter((unit) => unit.tree === 'shipped');
const shippedValues = walk.values.filter((value) => value.tree === 'shipped');
const names = sameName(shippedUnits);
// The value channel reads every group a shipped file takes part in: two shipped files, or a
// shipped file restated in a rig. Groups living entirely in rigs are not gated (see the header).
const values = duplicatedValues(walk.values).filter((group) =>
  group.members.some((member) => member.tree === 'shipped'),
);
const near = nearMatches(walk.units);

const crossBoundary = <T extends { family: string }>(rows: readonly T[]): T[] =>
  rows.filter((row) => row.family !== 'STORE-LAYER');

/**
 * Names declared in both a package and the lab, or in two packages, that are not forks.
 *
 * Every one was read in both places and a disagreeing input found, or the reason it cannot
 * disagree stated. A pattern is never allowed here: a pattern exempts the next match too, which
 * is the drift the gate exists for.
 */
const NAMES_ALLOWED = new Map<string, string>([
  [
    'collect',
    'coincidental: the conformance suite drains an async iterable into an array, the http server drains one while mapping each row through a projection, and neither could use the other without growing a parameter it has no caller for',
  ],
  [
    'add',
    'money delegates to the lab in one line; the second lab entry is TxHeads.add, a Map write',
  ],
  [
    'amount',
    "coincidental: money's is a getter handing back the branded Amount an instance already holds, the lab's builds one from a currency and a minor count",
  ],
  [
    'assertShareSum',
    'money checks a BpsValue list and the lab a Recipient list; money also refuses a negative share the lab accepts',
  ],
  [
    'bearerOf',
    'the deliberate mirror packages/test holds against auth, pinned identical by a 17-row differential in dev-grammar.test.ts',
  ],
  ['compare', "money delegates to the lab's compare in one line"],
  [
    'createClient',
    "the package composes transport around the lab's createClient and accepts a TokenSource the lab refuses by design",
  ],
  [
    'convertCeil',
    "money delegates to the lab's convertCeil; the rounding stays in src/money.ts",
  ],
  [
    'convertFloor',
    "money delegates to the lab's convertFloor; the rounding stays in src/money.ts",
  ],
  [
    'currency',
    "coincidental: money's is a field read on an Amount, the lab's is a traits lookup on an AccountRef",
  ],
  [
    'decode',
    "coincidental: webhook's picks a provider's decoder and reads raw callback bytes into a WebhookEvent, the lab's parses the money wire string into an Amount",
  ],
  [
    'is',
    'three separate error brands, each keyed on its own Symbol.for; sharing a body would destroy the discrimination',
  ],
  [
    'isZero',
    "money's Money form delegates; its Bps form reads a basis-point integer the lab's Amount version cannot take",
  ],
  [
    'legsOf',
    "coincidental: the engines read stored legs back out of SQL, the lab's builds a spend's split in memory",
  ],
  [
    'parse',
    'two argument grammars, not two spellings of one: the CLI reads a verb and a flag table, create-economy reads a directory and question flags',
  ],
  [
    'readMinor',
    'deliberate opposite divergence: money refuses a non-bigint, the lab coerces what a SQL driver hands back',
  ],
  [
    'refuse',
    'each builds its own package-local Parsed union; create-economy declares no dependencies at all, so neither can import the other',
  ],
  [
    'set',
    "coincidental: the CLI's adapts a void mutator to a boolean fold, the lab's writes TxHeads through a rollback journal",
  ],
  [
    'sleep',
    "core's unrefs its timer so a shutdown race cannot hold the process open; the lab's is retry backoff and must not",
  ],
  [
    'toHex',
    'packages/receipt is zero-dependency by a pinned test and structurally cannot import the lab; held identical by test/dedupe-receipt.test.ts',
  ],
  [
    'toRequest',
    "core keeps its own because the express and fastify seams need the buffered-body override the lab's does not take, and it is published on ./internal, so dropping it is a bump change (Q91)",
  ],
  [
    'version',
    'each resolves ../../package.json relative to its own module, so a shared body would read the wrong manifest for one of them',
  ],
]);

/**
 * Names shared only among the four files that hold a Store implementation.
 *
 * They repeat each other by construction — one port written three times over three drivers —
 * and unifying them is a store-layer design question, not a dedupe sweep. The roster is exact so
 * a new shared name is a decision, not a drift. What was genuinely duplicated here has already
 * moved: `rowToAccrual`, `rowToSale` and `endOwnedPool` now live in the lab's `sql-kit`.
 * `encodeOperation` was never a fork — one typed wrapper over the lab's own walk, written twice —
 * and it now lives beside its inverse in the wire contract, which both engines reach through
 * `sql-kit`.
 */
const STORE_LAYER_NAMES = [
  'advanceChain',
  'advanceSaga',
  'appendPostings',
  'archivePageOf',
  'archiveStateSurfaces',
  'buildStatement',
  'buildUnit',
  'createAccrualStore',
  'createCheckpointStore',
  'createEntitlementStore',
  'createIdempotencyStore',
  'createInboxStore',
  'createLedgerStore',
  'createMovementJournal',
  'createOutboxStore',
  'createPromoStore',
  'createReplayStore',
  'createReservationStore',
  'createSagaStore',
  'createSaleStore',
  'createSubscriptionStore',
  'createTrustStore',
  'createUnitTrustStore',
  'derivedBalancesOf',
  'encodeTransaction',
  'findSagaByRef',
  'headSumsOf',
  'headsForAccounts',
  'isKnownAccount',
  'isMissingSchemaTable',
  'isTransientConflict',
  'legsByPosting',
  'lineageOf',
  'linksPageOf',
  'listPostingsOf',
  'listSagasOf',
  'listSubscriptionsOf',
  'lotPage',
  'markAccruals',
  'postingOf',
  'pruneWholePostings',
  'putAccrualRows',
  'readSchemaVersion',
  'readTableSizes',
  'saleFromRow',
  'screenNewAccounts',
  'timelineOf',
  'verifySchemaAndMoney',
];

/**
 * Literal values written out in more than one file, at least one of them shipped, each with the
 * reason it stays that way. The six rig-side rows arrived with the 2026-07-31 widening: a rig
 * restating a shipped literal is usually a pin, and the row says which kind each one is.
 */
const VALUES_ALLOWED = new Map<string, string>([
  [
    String.raw`/\{(\w+)\}/g`,
    "OpenAPI's own path-templating convention, matched independently: the lab extracts parameters from it, core rewrites it to a router's :param",
  ],
  [
    String.raw`/^Bearer\s+(.+)$/i`,
    'the auth grammar packages/test mirrors on purpose, pinned identical by dev-grammar.test.ts',
  ],
  [
    '/^[0-9a-f]{64}$/',
    'a chain hash is 64 lowercase hex everywhere it is spelled: the lab states it, zero-dependency receipt cannot import it, and four rigs assert real heads against it',
  ],
  [
    '/^[0-9a-f]{16}$/',
    "receipt's own test pinning the key-id shape its src enforces: the test asserts a generated kid matches, so a drifted grammar fails the pin",
  ],
  [
    '/^[a-z_][a-z0-9_]*$/',
    "one grammar guarding two different pastes: the lab's stored-routine identifiers and the rig's disposable database names in CREATE/DROP; either copy drifting fails its own site loudly",
  ],
  [
    "'economy:ratelimit:'",
    "the redis package's own test writing the key prefix its src declares, so a renamed prefix strands the test's keys and fails it",
  ],
  [
    "'postgres' | 'mysql'",
    "the engine roster stated as SqlDialect in src and as the rig gate's SqlEngine: a third dialect must touch both, and the rig names them to say which env var a skip wants",
  ],
  [
    "[ 'appendAll', 'archive', 'batchTransaction', 'historySize', 'idempotencyRetention', 'journalRetention', 'journalSessionIds', 'lockMany', 'reproof', 'reservations', 'sealHeads', 'tableSizes', ]",
    'the deliberate capability-roster pin: conformance-contract restates STORE_CAPABILITIES so a capability added to one side fails the cross-check, and each file names the other',
  ],
  [
    "[ 'forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', ]",
    "the deliberate forwarding-header pin: server.test restates the roster to assert 'evidence, and only those', so a header added to src alone fails the pin",
  ],
  [
    '{ custodialCreditMinor: 0n, trustCashMinor: 0n, }',
    'the zero value an accumulator starts from, written where it is accumulated; no computation is shared',
  ],
  [
    '{ id: posting.txnId, postedAt, legs: posting.legs, links, meta: posting.meta, }',
    'each engine assembles the Transaction it just wrote from its own locals; the shared part is the Transaction type, which both import',
  ],
  [
    '{ store, digest: ctx.digest, clock: ctx.clock }',
    'the dependency bag a sweep hands its helper, spelled at each call; structural glue, not a computed value',
  ],
]);

/**
 * Near-match pairs above their channel threshold that cross a package boundary and are not
 * forks.
 *
 * The four `sampleEvent`/`op`/`fund` rows that used to sit here are gone, and that is the
 * kept-literal instrument working rather than an admission withdrawn: two fixture builders that
 * share only a shape score 0.235–0.500 on the kept stream and no longer surface. What still
 * surfaces from a rig shares its literals or its logic, and each row says which — except the
 * last, which is the one case measured where the kept stream reads a shared FIELD PATH as shared
 * body. That is the residue of the same erasure trade: collapsing literals is what made two
 * fixture builders identical, and keeping them is what makes two filters on `posting.meta.kind`
 * look alike. A third row of that shape is a reason to re-measure the instrument, not to admit it.
 */
const PAIRS_ALLOWED = new Map<string, string>([
  [
    'test/conformance/claim-lock-lifetime.race.test.ts#arrivesWithin <-> packages/conformance/src/store.ts#settlesWithin',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'test/adapters/http.test.ts#outboxRow <-> packages/conformance/src/store.ts#outboxRow',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'test/conformance/invariants.adversarial.test.ts#fundSpendable <-> packages/conformance/src/store.ts#fundSpendable',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'test/adapters/postgres.test.ts#outboxMessage <-> packages/conformance/src/store.ts#outboxRow',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'test/adapters/sqs.test.ts#sampleEvent <-> packages/conformance/src/dispatcher.ts#sampleEvent',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'test/worker/poison-kill.test.ts#inboxRow <-> packages/conformance/src/store.ts#inboxRow',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'test/conformance/claim-contention.race.test.ts#outboxRow <-> packages/conformance/src/store.ts#outboxRow',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'test/conformance/claim-lock-lifetime.race.test.ts#outboxRow <-> packages/conformance/src/store.ts#outboxRow',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'test/acceptance/smoke.test.ts#sampleEvent <-> packages/conformance/src/dispatcher.ts#sampleEvent',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'test/support/sweeps.ts#balancedPosting <-> packages/conformance/src/store.ts#fundSpendable',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'test/property.test.ts#program <-> packages/conformance/src/rate-limit.ts#verdicts',
    'the harness moved to packages/conformance, so fixture builders it has always shared shape with are cross-tree now rather than same-tree; neither side can import from the other, and the row shapes are the contract',
  ],
  [
    'src/bytes.ts#toBase64Url <-> packages/receipt/src/lib/receipt-signing.ts#encodeBase64Url',
    'packages/receipt is zero-dependency by a pinned test and structurally cannot import the lab; held identical by test/dedupe-receipt.test.ts',
  ],
  [
    'test/adapters/mysql-money-install-race.test.ts#runnerFor <-> packages/mysql/src/mysql.ts#moneyRunner',
    'a five-line SqlRunner over a pool. The dependency runs package -> lab, so a lab test structurally cannot import from packages/mysql, and moneyRunner is module-private there in any case',
  ],
  [
    'test/money-sql.test.ts#runnerFor <-> packages/mysql/src/mysql.ts#moneyRunner',
    'the second lab-side copy of that same SqlRunner wrapper, and blocked from importing it for the same structural reason: the lab does not depend on its own packages',
  ],
  [
    'packages/core/test/shutdown.test.ts#within <-> packages/webhook/test/bounded.test.ts#within',
    "deliberate opposites under one name: core's within rejects on timeout so a hang fails the test, webhook's resolves to the 'still reading' sentinel its assertions expect; one body would destroy one of the two meanings",
  ],
  [
    'test/worker/promos.test.ts#postingsOfKind <-> packages/events/test/emitted.test.ts#chargesFor',
    "what these two share is the field path posting.meta.kind, which the kept-literal stream reads as shared body; the logic under it is a filter over an async stream and nothing else. There is no lab reader to import instead: postings.meta is an unindexed json column, so a kind filter would scan whatever door it was offered at, unlike read.payouts, whose states/userId the SQL engines push down. And the generic form is the language's own Array.fromAsync, which the root program has (lib esnext) and no package does (all seventeen pin ES2023, measured). What is left to share is a for-await loop, which is glue",
  ],
]);

/**
 * Near-match pairs that ARE duplication, are recorded in the queue, and are held here at their
 * exact membership until the entry that owns them lands.
 *
 * Separate from `PAIRS_ALLOWED` on purpose: an admission says "this is not a fork", and writing
 * one of these there would be false. Most surfaced the day the walk grew to cover the rigs, which
 * is the widening doing its job; five of that crop — the framing probe, `installSecondCopy`, the
 * EdDSA signer, `throwingGetter` and the throwaway-database dance — have since been extracted to
 * shared homes and left the roster, and one more was read again and moved to `PAIRS_ALLOWED`.
 * What this roster buys is that the set cannot grow silently — the next rig fork fails the gate
 * rather than joining a pile.
 */
const PAIRS_FILED = new Map<string, string>([
  [
    'test/adapters/redis.test.ts#fakeCounter <-> packages/redis/test/redis.test.ts#fakeCounter',
    'Q161: the published ./testing kit runs the RateLimiter contract but keeps its fake client private, so both sides wrote the same one',
  ],
  [
    'test/adapters/redis.test.ts#fakeRedis <-> packages/redis/test/redis.test.ts#fakeRedis',
    'Q161: same cause one port over — the Cache contract runner ships, the fake it runs against does not',
  ],
  [
    'packages/conformance/src/rate-limit.ts#verdictOf <-> packages/redis/test/redis.test.ts#readVerdict',
    'Q161: the kit reduces a denial to whether its wait falls inside the window, and packages/redis restated that rule to compare against the same table',
  ],
  [
    'test/adapters/sqs.test.ts#sqsHarness <-> packages/sqs/test/sqs.test.ts#harness',
    "Q161: the kit ships runDispatcherConformance and keeps the harness it runs private, so the lab rig and the sqs rig each rebuilt the same stand-in client — bodies capture, signal capture, one-shot failure slot. The entry's own text names packages/sqs as the next claimant",
  ],
  [
    'test/adapters/sqs.test.ts#send <-> packages/sqs/test/sqs.test.ts#send',
    "Q161: the stand-in client's send closure out of that same harness, so the same copy counted a second time",
  ],
]);

/**
 * The known duplicated invariants that live entirely in rigs, where the value channel does not
 * read.
 *
 * A literal shared only among rigs is not gated — the 2026-07-31 measurement found 54 such
 * groups, almost all of them two tests expecting the same output — but these two families are
 * rules stated twice, not expectations shared, and each names the reason the second statement
 * exists. Held by their text at every site, so a row cannot outlive either copy: when the rule
 * moves to one home, this fails and the family comes out. A record, not a detector — a third
 * family of this shape is caught by reading, and the header says so.
 */
const RIG_INVARIANTS = [
  {
    family: 'the banned-vocabulary grammar',
    why: "the root suite gates sixteen package READMEs and core's fan-out suite gates its own, and a package rig cannot import the lab's unpublished test tree, so the vocabulary is stated once per suite",
    files: [
      'test/package-readmes.test.ts',
      'packages/core/test/readme.test.ts',
    ],
    texts: [
      String.raw`/\brungs?\b/i`,
      String.raw`/\bpeels?\b/i`,
      String.raw`/\baltitude\b/i`,
      String.raw`/\bdescends?\b/i`,
      String.raw`/\bR[0-3]\b/`,
    ],
  },
  {
    family: 'the dist-freshness reading grammar',
    why: 'the check-table step and the root-suite test each walk the emit on their own, so the count the gate rests on and the count the checker reports come from two readings of the disk, and each states which extensions tsc writes where it walks them. How a published specifier is spelled was the second half of this family until `Q366` moved it to one home, `publishedSpecifiers`, which both now import',
    files: ['scripts/check-dist-fresh.ts', 'test/dist-freshness.test.ts'],
    texts: ["['.js', '.d.ts']"],
  },
];

/**
 * Rules the lab states once and every consumer reaches by import.
 *
 * Both rows arrived here as forks — the same rule written as an inline expression in the lab and
 * again in `packages/ui`, in a form smaller than a function body and therefore invisible to all
 * three channels above. They were recorded by their text so the queue entry could not outlive the
 * copy. `Q89` and `Q127` landed the export, so the record inverts: what is held now is that each
 * rule has exactly ONE statement in the tree and that every named consumer both imports and calls
 * it. A copy pasted into a package takes the count to two and fails here.
 *
 * `text` is the discriminating part of the rule, not the whole declaration — for the join, the
 * expression a copy would carry; for the identity, the per-list table a copy would have to
 * restate. `symbol` is what a consumer imports, and it is required to appear again outside its
 * own import, because an import kept while the call is replaced by a local guess is the shape a
 * mere presence check would pass.
 *
 * WHAT THIS STILL DOES NOT FIND, unchanged from when the rows were forks: a copy REWRITTEN into
 * different text. No channel above sees a rule smaller than a function body, and neither does
 * this. It is why the consumers are named rather than inferred.
 */
const LAB_OWNED_RULES = [
  {
    rule: 'how a base URL joins a path',
    owner: 'Q127',
    symbol: 'joinUrl',
    lab: 'src/client.ts',
    text: "`${base.replace(/\\/+$/, '')}/${path.replace(/^\\/+/, '')}`",
    consumers: ['packages/ui/src/lib/core.ts'],
  },
  {
    rule: 'which field carries a list row’s identity',
    owner: 'Q89',
    symbol: 'wireRowIdentity',
    lab: 'src/client.ts',
    text: "entitlements: 'sku',",
    consumers: ['packages/ui/src/lib/core.ts'],
  },
];

const LAB_CLIENT_SPECIFIER = '@pwngh/economy-lab/client';

/** This file, which states every needle above and so is a second stater of each by construction. */
const GATE_FILE = 'test/dedupe.test.ts';

// The failure this whole gate is built against is a gate that reports success having examined
// nothing — six recorded instances in this tree. So the walk is asserted before anything it
// produced is, and each floor is the count observed when the roster below was written.
//
// Counted per tree rather than in total, because a single combined floor is exactly how a
// widening gets undone: `src/` growing by three hundred files would cover every rig dropping out
// of the walk, and the run would still be green.
test('the sweep reads all four trees, and a file it cannot parse stops it', () => {
  assert.equal(walk.parseFailures, 0);
  const enumerated = sourceFiles(ROOT);
  assert.equal(
    enumerated.length,
    walk.files.length,
    'a file was enumerated and then not parsed',
  );
  for (const file of walk.files) {
    assert.ok(existsSync(join(ROOT, file)), `${file} does not exist`);
  }

  const shippedFiles = enumerated.filter((f) => f.tree === 'shipped');
  const rigFiles = enumerated.filter((f) => f.tree === 'rig');
  assert.ok(
    shippedFiles.length >= 183,
    `walked ${shippedFiles.length} shipped files, fewer than the 183 this roster was written against`,
  );
  assert.ok(
    rigFiles.length >= 299,
    `walked ${rigFiles.length} rig files, fewer than the 299 this roster was written against`,
  );
  assert.ok(
    shippedUnits.length >= 2106,
    `extracted ${shippedUnits.length} shipped function units, fewer than 2106`,
  );
  assert.ok(
    walk.units.length - shippedUnits.length >= 2340,
    `extracted ${walk.units.length - shippedUnits.length} rig function units, fewer than 2340`,
  );
  assert.ok(
    shippedValues.length >= 308,
    `extracted ${shippedValues.length} shipped literal values, fewer than 308`,
  );

  // Every rig directory the walk is supposed to reach, named. A tree that stops being read is the
  // failure this whole item is about, and a floor on a total cannot see it.
  const reached = new Set(
    rigFiles.map((f) =>
      relative(ROOT, f.path).split('/').slice(0, 3).join('/'),
    ),
  );
  for (const tree of [
    'test',
    'scripts',
    'packages/core/test',
    'packages/ui/test',
    'packages/adapters/scripts',
    'packages/economy/scripts',
  ]) {
    assert.ok(
      [...reached].some((seen) => seen === tree || seen.startsWith(`${tree}/`)),
      `${tree} is not in the walk`,
    );
  }

  // Both trees are present: a walker pointed at one of them would satisfy every count above.
  const scopes = new Set(walk.units.map((unit) => unit.scope));
  assert.ok(scopes.has('lab'), 'no lab units were read');
  assert.ok(
    scopes.size >= 15,
    `read ${scopes.size} trees, expected 15 or more`,
  );
});

/**
 * The trees a search has to be able to read, and the extensions that carry source in them.
 *
 * Wider than `sourceFiles` above on purpose: that walk feeds the fork channels and reads
 * TypeScript, while a byte that hides a file hides it from every reader regardless of language.
 * A directory named here and found empty fails below, so a rename cannot quietly shrink the
 * population — this gate is one directory away from being the kind that examines nothing.
 */
const SEARCHED_TREES = [
  'src',
  'test',
  'scripts',
  'packages',
  'apps',
  'rigs',
] as const;

const SEARCHED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.sh',
  '.sql',
  '.css',
  '.html',
  '.svg',
  '.txt',
  '.yml',
  '.yaml',
]);

const NOT_SEARCHED = new Set([
  'node_modules',
  'dist',
  'build',
  '.build-tmp',
  'coverage',
  '.git',
  '.next',
  '.turbo',
]);

function searchedFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return NOT_SEARCHED.has(entry.name) ? [] : searchedFiles(path);
      }
      return SEARCHED_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    })
    .sort();
}

/** What makes a reader skip a file: a NUL byte, or bytes that are not UTF-8. */
function unreadableAs(bytes: Buffer): string | null {
  const nul = bytes.indexOf(0);
  if (nul !== -1) return `a NUL byte at offset ${nul}`;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'bytes that are not UTF-8';
  }
  return null;
}

/**
 * No source file carries a byte that makes a search tool skip it.
 *
 * This is one layer below every gate in this file: the instruments here read the tree, and so do
 * the people. A NUL byte anywhere in a file makes `grep` print **nothing at all** — not a "binary
 * file matches" line, nothing — and makes `rg` answer `binary file matches` with no line numbers
 * unless `--text` is passed, which nothing prompts a caller to do. Both of the files that carried
 * one were building a key on a separator that cannot occur in the data, which is the right
 * technique; the wrong part was typing the separator as a raw `0x00` instead of the `\0` escape
 * that produces the identical string. One of the two was `test/support/dedupe.ts`, this gate's own
 * implementation, invisible to every sweep run against it for as long as it stood.
 *
 * The failure it cost is recorded: a pass grepping `packages/ui/src/lib/core.ts` for two symbols
 * got nothing back for either and concluded both had been deleted. They were both there.
 */
test('every source file in the tree can be read by a search tool', () => {
  // The detector first, against bytes that carry the defect. A sweep that examines everything and
  // finds nothing is indistinguishable from one whose test never fires.
  assert.match(
    unreadableAs(Buffer.from('id\0value', 'utf8')) ?? '',
    /NUL byte at offset 2/,
    'the NUL detector does not fire on a NUL',
  );
  assert.equal(
    unreadableAs(Buffer.from([0x41, 0xff, 0x42])),
    'bytes that are not UTF-8',
    'the encoding detector does not fire on invalid UTF-8',
  );
  assert.equal(unreadableAs(Buffer.from('plain source', 'utf8')), null);

  let examined = 0;
  const unreadable: string[] = [];
  for (const tree of SEARCHED_TREES) {
    const files = searchedFiles(join(ROOT, tree));
    assert.ok(
      files.length > 0,
      `${tree}/ is named here and holds no searched file — the tree moved, or the extension list stopped matching it`,
    );
    for (const path of files) {
      examined += 1;
      const why = unreadableAs(readFileSync(path));
      if (why !== null) unreadable.push(`${relative(ROOT, path)}: ${why}`);
    }
  }

  assert.deepEqual(unreadable, []);
  // Recounted from git's tracked tree: 39599ff has 952 matching files, and balance holds adds
  // three. The former 1010 floor was already above the clean checkout's population. Keep a
  // floor over authored files without requiring generated or untracked local artifacts.
  assert.ok(
    examined >= 955,
    `read ${examined} files, fewer than the 955 in the clean-checkout baseline`,
  );
});

test('no name is declared in two trees, unless it is admitted with a reason', () => {
  const found = crossBoundary(names);
  const unexplained = found.filter((group) => !NAMES_ALLOWED.has(group.name));
  assert.deepEqual(
    unexplained.map(
      (group) =>
        `${group.name}: ${group.members.map((m) => `${m.file}:${m.line}`).join(' ')}`,
    ),
    [],
    'a name is declared in two trees with no entry in NAMES_ALLOWED',
  );
  assert.equal(found.length, NAMES_ALLOWED.size);
  assert.equal(found.length, 22);
});

// An admission that outlives the thing it admits stops being a reason and becomes a hole.
test('every admitted name is still declared twice, and still carries a reason', () => {
  const byName = new Map(crossBoundary(names).map((g) => [g.name, g]));
  for (const [name, reason] of NAMES_ALLOWED) {
    const group = byName.get(name);
    assert.ok(
      group,
      `${name} is admitted but is no longer declared in two trees`,
    );
    assert.ok(
      group!.members.length >= 2,
      `${name} is admitted but has ${group!.members.length} declaration`,
    );
    assert.ok(
      reason.length > 20,
      `${name} is admitted with no reason worth reading`,
    );
  }
  assert.equal(NAMES_ALLOWED.size, 22);
});

// The store layer repeats itself by construction. Reported apart so it does not drown the axis
// that matters, and exact so a new shared name is a decision rather than a drift.
test('the store layer shares exactly the names it is recorded as sharing', () => {
  const found = names
    .filter((group: NameGroup) => group.family === 'STORE-LAYER')
    .map((group) => group.name);
  assert.deepEqual(found, STORE_LAYER_NAMES);
  assert.equal(found.length, 48);
});

test('no literal value is written in two files, unless it is admitted with a reason', () => {
  const unexplained = values.filter(
    (group: ValueGroup) => !VALUES_ALLOWED.has(group.text),
  );
  assert.deepEqual(
    unexplained.map(
      (group) =>
        `${group.text} @ ${group.members.map((m) => `${m.file}:${m.line}`).join(' ')}`,
    ),
    [],
    'a literal is written in two files with no entry in VALUES_ALLOWED',
  );
  assert.equal(values.length, VALUES_ALLOWED.size);
  assert.equal(values.length, 12);
});

test('every admitted value is still written in two files', () => {
  const byText = new Map(values.map((group) => [group.text, group]));
  for (const [text, reason] of VALUES_ALLOWED) {
    const group = byText.get(text);
    assert.ok(group, `${text} is admitted but is no longer duplicated`);
    assert.ok(
      new Set(group!.members.map((m) => m.file)).size >= 2,
      `${text} is admitted but now sits in one file`,
    );
    assert.ok(
      reason.length > 20,
      `${text} is admitted with no reason worth reading`,
    );
  }
  assert.equal(VALUES_ALLOWED.size, 12);
});

test('no body survives renaming into another tree, unless it is admitted or filed', () => {
  const found = crossBoundary(near.pairs).map(
    (pair) => `${keyOf(pair.left)} <-> ${keyOf(pair.right)}`,
  );
  const unexplained = found.filter(
    (pair) => !PAIRS_ALLOWED.has(pair) && !PAIRS_FILED.has(pair),
  );
  assert.deepEqual(
    unexplained,
    [],
    'a body scores at or above its channel threshold across a package boundary with no entry in PAIRS_ALLOWED or PAIRS_FILED',
  );
  assert.equal(found.length, PAIRS_ALLOWED.size + PAIRS_FILED.size);
  assert.equal(found.length, 21);
  // The rigs are where twenty of the twenty-one live, and the channel earns its widening only if
  // it is still reading them. Counted, so a walk that quietly lost the rig trees fails here too.
  // Eleven arrived at once when the conformance harness became a package: fixture builders it had
  // always shared a shape with went from same-tree to cross-tree without a line of either moving.
  assert.equal(
    crossBoundary(near.pairs).filter((pair) => pair.channel === 'rig').length,
    20,
  );

  // The line above is what catches an emptied candidate set: it demands the receipt pair be FOUND,
  // so a prune that silently drops everything reports 0 and fails. Measured — knocking the
  // candidate filter out fails this test and two more.
  assert.ok(
    walk.units.filter((unit) => unit.tokens.length >= MIN_TOKENS).length >= 700,
    'the length floor left too few units to compare',
  );
});

test('every admitted or filed pair still scores above its channel threshold', () => {
  const found = new Set(
    near.pairs.map((pair) => `${keyOf(pair.left)} <-> ${keyOf(pair.right)}`),
  );
  for (const [pair, reason] of [...PAIRS_ALLOWED, ...PAIRS_FILED]) {
    assert.ok(
      pair && found.has(pair),
      `${pair} is listed but no longer scores above its channel threshold`,
    );
    assert.ok(
      reason.length > 20,
      `${pair} is listed with no reason worth reading`,
    );
  }
  assert.equal(PAIRS_ALLOWED.size, 16);
  assert.equal(PAIRS_FILED.size, 5);
  // A filed pair names the entry that owns it, so the roster cannot become a quiet exemption.
  for (const [pair, reason] of PAIRS_FILED) {
    assert.match(reason, /^Q\d+: /, `${pair} is filed against no queue entry`);
  }
});

// Two rules the lab states once. No channel above can see a copy of either, because both are
// smaller than a function body, so what is asserted is that the tree holds one statement of each
// and that every consumer imports and calls it.
test('each rule the lab owns is stated once, and its consumers import it', () => {
  assert.equal(LAB_OWNED_RULES.length, 2);

  // The detector, against text carrying the defect, before it is turned on the tree: a sweep that
  // reads every file and finds nothing looks the same as one whose match never fires.
  const stating = (text: string, sources: readonly [string, string][]) =>
    sources.filter(([, body]) => body.includes(text)).map(([file]) => file);
  assert.deepEqual(
    stating('needle', [
      ['a.ts', 'const x = needle;'],
      ['b.ts', 'nothing'],
      ['c.ts', '// needle'],
    ]),
    ['a.ts', 'c.ts'],
    'the text detector does not find text that is there',
  );

  // Every file the walk reads, by its own enumeration, so a rule cannot be restated in a tree
  // this gate is not looking at. This file is the one exclusion: it holds each needle as data and
  // would otherwise report itself as a second copy of every rule it gates. One named file, not a
  // pattern, and it has to be in the walk for the exclusion to mean anything.
  assert.ok(walk.files.includes(GATE_FILE), `${GATE_FILE} is not in the walk`);
  const population = walk.files.filter((file) => file !== GATE_FILE);
  assert.equal(population.length, walk.files.length - 1, 'one file excluded');
  const sources = population.map(
    (file) =>
      [file, readFileSync(join(ROOT, file), 'utf8')] as [string, string],
  );
  assert.ok(
    sources.length >= 511,
    `read ${sources.length} files, fewer than the 511 this roster was written against`,
  );

  let examined = 0;
  for (const rule of LAB_OWNED_RULES) {
    assert.match(rule.owner, /^Q\d+$/);
    assert.ok(existsSync(join(ROOT, rule.lab)), `${rule.lab} is not there`);

    assert.deepEqual(
      stating(rule.text, sources),
      [rule.lab],
      `${rule.owner}: ${rule.rule} is stated somewhere other than ${rule.lab}, or no longer stated there at all`,
    );

    for (const consumer of rule.consumers) {
      const body = readFileSync(join(ROOT, consumer), 'utf8');
      assert.match(
        body,
        new RegExp(
          `import\\s*\\{[^}]*\\b${rule.symbol}\\b[^}]*\\}\\s*from\\s*'${LAB_CLIENT_SPECIFIER}'`,
        ),
        `${consumer} does not import ${rule.symbol} from the lab`,
      );
      assert.ok(
        body.split(rule.symbol).length - 1 >= 2,
        `${consumer} imports ${rule.symbol} and never calls it — the rule was replaced by something local`,
      );
      assert.notEqual(consumer, rule.lab);
      examined += 1;
    }
  }
  assert.equal(examined, 2, `resolved ${examined} consumers`);
});

// Two rule families stated twice inside rigs, where the value channel does not read. Held by
// their text at every site so a row cannot outlive either copy; nothing here finds a third
// family.
test('the rig-side invariant families are still stated at every recorded site', () => {
  assert.equal(RIG_INVARIANTS.length, 2);
  let examined = 0;
  for (const family of RIG_INVARIANTS) {
    assert.ok(family.files.length >= 2, `${family.family} names one file`);
    assert.ok(
      family.why.length > 20,
      `${family.family} carries no reason worth reading`,
    );
    for (const file of family.files) {
      const path = join(ROOT, file);
      assert.ok(existsSync(path), `${file} is recorded and is not there`);
      const text = readFileSync(path, 'utf8');
      for (const stated of family.texts) {
        examined += 1;
        assert.ok(
          text.includes(stated),
          `${family.family}: ${file} no longer states ${stated} — if the rule moved to one home, this family comes out`,
        );
      }
    }
  }
  assert.equal(examined, 12, `resolved ${examined} statements`);
});

// Twenty of the thirty pairs above their thresholds are the two engines against each other.
// Counted rather than listed: the roster that matters is the name one above, and this number is
// here so the family cannot quietly grow while the reader is looking at the other axis. The
// twins are all shipped — the store layer has no rig half, so the rig instrument never touches
// them, and the collapsed one still must: their kept scores reach down to 0.543. The total is the
// second number for the same reason: a pair arriving anywhere fails one of the two, and a pair
// can arrive in the rigs rather than here.
test('the engine twins are the family they are recorded as', () => {
  const twins = near.pairs.filter((pair) => pair.family === 'STORE-LAYER');
  assert.equal(twins.length, 20);
  assert.equal(near.pairs.length, 41);
  for (const pair of twins) {
    assert.equal(pair.channel, 'shipped');
    assert.ok(pair.dice >= thresholdFor(pair.channel));
    assert.notEqual(pair.left.scope, pair.right.scope);
    assert.equal(pair.left.tree, 'shipped');
    assert.equal(pair.right.tree, 'shipped');
  }
});
