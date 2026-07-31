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

// The one definition of green. Every gate this repository runs is a row in STEPS, and every
// caller runs the table rather than a list of its own: `npm run check` executes all of it,
// `node scripts/check.ts <tier>` or `<step id>` executes part of it, and `.github/workflows/ci.yml`
// invokes those tiers and nothing else. `test/check-gate.test.ts` holds both ends.
//
// It replaces a nine-command `&&` chain. A chain names no step, times none and counts none, so a
// gate could go red inside it and the landing still report every gate green — which is how
// `check-samples` was found red in the tree.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BUILDS_DATED, assertBuildsFresh } from './check-dist-fresh.ts';
import { describeReach, reachesDist } from './support/dist-reach.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const TIERS = ['static', 'unit', 'integration', 'acceptance'] as const;

export type Tier = (typeof TIERS)[number];

export interface CheckStep {
  readonly id: string;
  readonly tier: Tier;
  /** argv for the step, spawned without a shell. */
  readonly run: readonly string[];
  /**
   * What the step needs that a bare checkout does not have, or null once it is there. A step
   * whose precondition is unmet reports SKIP naming the missing capability, and the run still
   * reconciles: reported equals selected.
   */
  readonly needs?: () => string | null;
  /**
   * Evidence the step did its work, read out of its own output. A command that exits 0 having
   * examined nothing is the recurring failure here, so a test step returns its counts and
   * refuses on zero.
   */
  readonly evidence?: (output: string, step: CheckStep) => Evidence;
  /**
   * How much of itself this step must run. Required of every step whose evidence reports a run,
   * because a verdict on a step that mostly skipped is a verdict on nothing.
   */
  readonly floor?: Floor;
}

/** What a step's output proves it did. */
export interface Evidence {
  /** The step line's tail. */
  readonly note: string;
  /** Present when the step ran tests, which is what a floor is applied to. */
  readonly ran?: Ran;
}

export interface Ran {
  /** Tests the step registered. */
  readonly tests: number;
  /** Tests that actually executed — the registered ones less every skip and todo. */
  readonly ran: number;
  /**
   * Suites skipped whole. Their tests are never registered, so they are missing from `tests` as
   * well as from `ran`: `describe(…, { skip })` around two tests reports one suite, one skip
   * line, and `# tests 0`. A share of what was registered cannot see them, which is why they are
   * counted apart.
   */
  readonly suites: number;
  /** What the skips said they needed, deduplicated, in the order they were printed. */
  readonly needed: readonly string[];
  /**
   * What the todos said is not proven here. A todo withholds a test exactly as a skip does and is
   * subtracted from `ran` the same way, so a step short of itself for todos alone still has to say
   * what they were: `adversarial` reported `partial … needs` with nothing after it.
   */
  readonly pending: readonly string[];
}

/**
 * The share of its own registered tests a step must run before its verdict says anything. Under
 * it the step fails; at or above it, a step that skipped anything reports `partial` rather than
 * `ok`, because `5 pass, 0 skip` and `3 pass, 2 skip` were the same word here for a long time.
 *
 * It cannot be "no skips" for every step: the tree's two dozen named skips are deliberate, and a
 * step whose tests each name an engine or a service they cannot reach has no honest number above
 * zero. Those steps declare zero and say why, which is the exemption written down per step rather
 * than assumed — and `partial` still carries what they skipped.
 */
export interface Floor {
  /** A share of the step's own tests, 0 to 1. */
  readonly ran: number;
  readonly why: string;
}

/** Every `*.test.ts` under test/, at any depth — the set `npm test` runs. */
function testFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFilesUnder(path));
    else if (entry.name.endsWith('.test.ts')) found.push(relative(ROOT, path));
  }
  return found.sort();
}

export const ALL_TEST_FILES = testFilesUnder(join(ROOT, 'test'));

/**
 * The property suites, run as their own step. A shrunk counterexample and its seed are then the
 * whole output of one named step instead of six lines inside a suite of 1800.
 *
 * Listed rather than globbed: `test/property-*.test.ts`, which `npm run prop` used, does not
 * match `test/property.test.ts`, so that suite never ran in the step named for it.
 */
export const PROPERTY_FILES = [
  'test/propcheck.test.ts',
  'test/property-adversarial.test.ts',
  'test/property-based.test.ts',
  'test/property-money.test.ts',
  'test/property-replay.test.ts',
  'test/property.test.ts',
] as const;

const conformance = testFilesUnder(join(ROOT, 'test', 'conformance'));

/** The cross-engine conformance suites, minus the hostile ones, which get their own step. */
export const CONFORMANCE_FILES = conformance.filter(
  (file) => !file.includes('.adversarial.'),
);

export const ADVERSARIAL_FILES = conformance.filter((file) =>
  file.includes('.adversarial.'),
);

export const ENGINE_FILES = testFilesUnder(join(ROOT, 'test', 'engines'));

/** Packs the scaffolder, installs it in a clean directory, boots it and drives it over HTTP. */
export const ACCEPTANCE_FILES = ['test/create-economy.walk.test.ts'] as const;

/** The same scaffolded projects, served against whichever engine rigs this run can reach. */
export const RIG_FILES = ['test/acceptance/rigs.test.ts'] as const;

/** The optional adapters against their real services and real SDKs. */
export const SMOKE_FILES = ['test/acceptance/smoke.test.ts'] as const;

/**
 * The randomized invariant prover and the cross-backend differential, each its own step. Both were
 * `scripts/` entry points signalling by exit code until `Q53` S6 moved them here, so nothing
 * counted their vectors and `fuzz` had no evidence function at all.
 */
export const PROVE_FILES = ['test/prove.test.ts'] as const;

export const FUZZ_FILES = ['test/fuzz.test.ts'] as const;

const claimed = new Set<string>([
  ...PROPERTY_FILES,
  ...CONFORMANCE_FILES,
  ...ADVERSARIAL_FILES,
  ...ENGINE_FILES,
  ...ACCEPTANCE_FILES,
  ...RIG_FILES,
  ...SMOKE_FILES,
  ...PROVE_FILES,
  ...FUZZ_FILES,
]);

/** Everything no named step above claims. Computed, so no suite can fall out of the table. */
export const SUITE_FILES = ALL_TEST_FILES.filter((file) => !claimed.has(file));

/**
 * The backstop every `node --test` in this repository carries. `node --test` has no default
 * timeout, so a test waiting on a lock, a child process or a socket hangs instead of failing, and
 * a hang reports nothing at all. The flag bounds each test FILE, not each test — a file is
 * cancelled once its tests together pass this — and the parent runner enforces it, so it kills a
 * child blocked inside a synchronous call as well as one awaiting a promise nobody will settle.
 *
 * The number is a multiple of the slowest file measured, not a guess. That file is
 * `claim-contention.race.test.ts` under the full parallel root suite; nothing else in the tree
 * comes near it. It sits inside every CI job's own `timeout-minutes`, so a hang is named here
 * rather than killing the job unexplained.
 *
 * It is a backstop, not the bound that catches a wedge quickly. That job belongs to the ceilings
 * at the call sites that genuinely wait, and `test/hang-bounds.test.ts` holds both ends.
 */
export const TEST_TIMEOUT_MS = 600_000;

/**
 * How long one step may run. The table's own runner used `spawnSync` with no timeout, so a step
 * that wedged took `npm run check` with it. Past this the step is killed and reported, and the
 * bound above fires first for every step that is a test runner.
 */
export const STEP_TIMEOUT_MS = 1_200_000;

/**
 * Attached beside TAP by every runner in this repository. TAP's totals are computed after a dead
 * child is already dead, so a file that ends its own process reads there as one passing test and
 * the tests it took with it cannot be missed. This reporter adds up the counts each file reported
 * for itself, which is the number that child could not have written.
 */
const COUNTED = './scripts/support/counted.reporter.mjs';

const nodeTest = (files: readonly string[]): string[] => [
  process.execPath,
  '--env-file-if-exists=.env',
  `--test-timeout=${TEST_TIMEOUT_MS}`,
  '--test',
  '--test-reporter=tap',
  '--test-reporter-destination=stdout',
  `--test-reporter=${COUNTED}`,
  '--test-reporter-destination=stderr',
  ...files,
];

/** What the counted reporter says the files themselves reported. */
const ACCOUNTED =
  /^counted: (\d+) files, (\d+) tests, (\d+) pass, (\d+) fail, (\d+) skip$/m;

/** A withheld test as TAP prints it: which directive held it back, and what that directive said. */
const WITHHELD = /^\s*ok \d+ - .+? # (SKIP|TODO)(?: (.*))?$/gm;

/**
 * TAP counts, reconciled, or a refusal. Exit status alone is not evidence a runner ran anything,
 * and neither is a total: two readings of the same run are compared here — node's own TAP totals,
 * printed by the parent after every child has ended, against the per-file counts the children
 * reported while they were alive.
 */
function testCounts(output: string, step: CheckStep): Evidence {
  const read = (field: string): number =>
    Number(new RegExp(`^# ${field} (\\d+)$`, 'm').exec(output)?.[1] ?? NaN);
  const tests = read('tests');
  const pass = read('pass');
  if (Number.isNaN(tests) || Number.isNaN(pass)) {
    throw new Error('the runner printed no counts, so it reported on nothing');
  }
  if (tests === 0) {
    throw new Error('the runner matched no tests');
  }
  // A file killed by --test-timeout is reported `cancelled`, never `fail`, so a step that timed
  // out would otherwise print "0 fail" beside its refusal.
  const cancelled = read('cancelled');
  if (cancelled > 0) {
    throw new Error(
      `${cancelled} test(s) were cancelled — a file passed --test-timeout=${TEST_TIMEOUT_MS} and was killed, so something waited rather than finished`,
    );
  }

  const skipped = read('skipped');
  const todo = read('todo');
  const accounted = ACCOUNTED.exec(output);
  if (accounted === null) {
    throw new Error(
      `the run printed no accounting line, so ${COUNTED} never reported — without it a file that ends its own process is counted as one passing test`,
    );
  }
  const asked = step.run.filter((arg) => arg.endsWith('.test.ts')).length;
  const [, files, ownTests, ownPass, ownFail, ownSkip] = accounted.map(Number);
  if (files !== asked) {
    throw new Error(
      `${asked} test file(s) were named on the command line and ${files} reported`,
    );
  }
  const mine = [tests, pass, read('fail'), skipped + todo];
  const theirs = [ownTests, ownPass, ownFail, ownSkip];
  if (mine.some((figure, at) => figure !== theirs[at])) {
    throw new Error(
      `the run's totals say ${mine.join('/')} tests/pass/fail/skip and the files themselves reported ${theirs.join('/')} — a file that left the run is counted whole in the first and missing from the second`,
    );
  }

  // Q83: a withheld test states what it needs, or it is a test quietly not running. The rule is
  // the directive's, not the word's — a todo withholds a test as completely as a skip.
  const needed = new Set<string>();
  const pending = new Set<string>();
  let lines = 0;
  for (const [, directive, reason] of output.matchAll(WITHHELD)) {
    lines += 1;
    if (reason === undefined || reason.trim() === '') {
      throw new Error(
        `a test was held back by ${directive} without naming why, so nothing here can say what went unproven`,
      );
    }
    (directive === 'SKIP' ? needed : pending).add(reason.trim());
  }
  // Every withheld test prints a directive line and is counted; a suite skipped whole prints one
  // and is counted nowhere. The difference is how many suites took their tests out of the total.
  const suites = lines - skipped - todo;
  if (suites < 0) {
    throw new Error(
      `the run reports ${skipped} skipped and ${todo} todo test(s) and prints ${lines} directive line(s), so the two cannot be reconciled`,
    );
  }

  return {
    // `todo` is printed beside `skipped` because the broker's summary folds the two together, and
    // a step whose numbers cannot be added up against the root suite's is a number nobody trusts.
    note: `${tests} tests, ${pass} pass, ${read('fail')} fail, ${skipped} skip, ${todo} todo`,
    ran: {
      tests,
      ran: tests - skipped - todo,
      suites,
      needed: [...needed],
      pending: [...pending],
    },
  };
}

/**
 * The image step's own verdict. A cached build boots and answers in about a second, which is
 * exactly what a step that quietly stopped doing anything also looks like, so the status it
 * measured is read back out rather than trusted to the exit code.
 *
 * The store the container ran on is part of that verdict, not a detail: `memory` and `postgres`
 * are two different claims about the same green line, and this is where the step line says which
 * one was made.
 */
function imageAnswer(output: string): Evidence {
  const line =
    /^image: (\S+) booted (\S+) on (\S+) and answered \/healthz (\d{3}) /m.exec(
      output,
    );
  if (line === null) {
    throw new Error('the image step reported no boot, so it proved nothing');
  }
  if (line[4] !== '200') {
    throw new Error(`the health check answered ${line[4]}`);
  }
  return { note: `${line[1]} ran ${line[2]} on ${line[3]}, /healthz 200` };
}

/**
 * `check:ref` resolves the commit `apps/docs` pins as REPO_REF and lists the sources that moved
 * since it. On a working tree with uncommitted edits it is red by construction, which would make
 * the whole gate permanently red for the person holding those edits.
 */
function committedTree(): string | null {
  const git = spawnSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (git.status !== 0) return 'a git working tree';
  return git.stdout.trim() === ''
    ? null
    : 'a committed tree — REPO_REF names a commit that must already carry the sources the docs cite';
}

/**
 * The site step's own verdict. Composing an empty tree, or one whose console rule was generated
 * with no hashes in it, exits 0 through every page-by-page check — so the counts it examined are
 * read back out and a zero in either is a refusal.
 */
function siteAnswer(output: string): Evidence {
  const line =
    /^site: composed (\S+) from (\d+) inputs \((\d+) dated\), (\d+) pages, (\d+) console script hashes/m.exec(
      output,
    );
  if (line === null) {
    throw new Error('the site step composed nothing, so it proved nothing');
  }
  if (line[4] === '0' || line[5] === '0') {
    throw new Error(
      `the composed site has ${line[4]} pages and ${line[5]} console script hashes`,
    );
  }
  return {
    note: `${line[1]} — ${line[2]} inputs, ${line[4]} pages, ${line[5]} hashes`,
  };
}

/**
 * The site step composes `dist-site/` out of three builds. The acceptance tier produces all three
 * before it runs, so on a whole-tier run the precondition is met; a step selected alone on a tree
 * with no app builds gets a named skip rather than a refusal about a directory the developer
 * never asked for.
 */
function composedInputs(): string | null {
  const missing = [
    'apps/docs/build/client/index.html',
    'apps/console/build/client/index.html',
    'docs/index.html',
  ].filter((marker) => !existsSync(join(ROOT, marker)));
  return missing.length === 0
    ? null
    : `the composed site's inputs — ${missing.length} of 3 unbuilt; npm run site builds all three`;
}

/**
 * The image step builds and boots the container. A developer without a running daemon gets a
 * named skip; CI's ubuntu runner has one, which is where the repository proves it can run its own
 * product the way it ships it.
 */
function dockerDaemon(): string | null {
  const run = spawnSync(
    'docker',
    ['version', '--format', '{{.Server.Version}}'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  return run.status === 0 ? null : 'a running docker daemon (colima start)';
}

/**
 * The table. A row is a gate that exists today; nothing here is a placeholder for a gate a later
 * step of the toolchain reshape will build.
 *
 * The tiers are preconditions, not severities. `static` needs a checkout and the emit; `unit`
 * needs the test runners; `integration` needs the four rigs, and every one of its steps skips the
 * engines it cannot reach, so no step there requires Docker — which is what lets
 * `prepublishOnly` run the whole thing; `acceptance` needs a packed scaffold and the two apps'
 * own node_modules, and its one Docker step names the daemon as a precondition rather than
 * assuming it.
 *
 * The apps' gates are named here and implemented in each app's own scripts directory. A workspace
 * member owning its build tooling is what a member is; the table's job is that one command still
 * answers "is it green" without moving that tooling to the root.
 */
export const STEPS: readonly CheckStep[] = [
  // Both emits are gitignored, and every suite in the tree reads one of them. Reporting a stale
  // emit rather than rebuilding it is deliberate: a rebuild hides the staleness from the person
  // who needs to know their last edit never reached what they are about to test.
  {
    id: 'fresh:dist',
    tier: 'static',
    run: [process.execPath, 'scripts/check-dist-fresh.ts'],
  },
  {
    id: 'fresh:docs',
    tier: 'static',
    run: [process.execPath, 'scripts/check-docs-fresh.ts'],
  },
  {
    id: 'node-floor',
    tier: 'static',
    run: [process.execPath, 'scripts/check/node-floor.ts'],
  },
  { id: 'typecheck', tier: 'static', run: ['npm', 'run', 'typecheck'] },
  { id: 'lint', tier: 'static', run: ['npm', 'run', 'lint'] },
  { id: 'format', tier: 'static', run: ['npm', 'run', 'format:check'] },
  // The two pinned surfaces: the canonical trace against its golden, and the browser bundle
  // against the specifiers allowed to stay external.
  { id: 'trace', tier: 'static', run: ['npm', 'run', 'trace:check'] },
  { id: 'browser', tier: 'static', run: ['npm', 'run', 'check:browser'] },

  // Reads `partial` on every healthy run, and that is the honest word: the tree keeps two dozen
  // deliberate skips, each naming a capability, so this step never runs whole. What separates a
  // healthy partial from a broken one is on the step line — the capabilities its skips named.
  {
    id: 'suite',
    tier: 'unit',
    run: nodeTest(SUITE_FILES),
    evidence: testCounts,
    floor: {
      ran: 0.95,
      why: 'the tree names two dozen skips in two thousand tests, so a suite that skipped a twentieth of itself has stopped being the suite',
    },
  },
  {
    id: 'property',
    tier: 'unit',
    run: nodeTest(PROPERTY_FILES),
    evidence: testCounts,
    floor: {
      ran: 1,
      why: 'the property suites reach no service — every case is generated and checked in this process, so nothing here has anything to skip for',
    },
  },
  { id: 'packages', tier: 'unit', run: ['npm', 'run', 'test:packages'] },

  {
    id: 'engines',
    tier: 'integration',
    run: nodeTest(ENGINE_FILES),
    evidence: testCounts,
    floor: {
      ran: 0,
      why: 'every test here names the engine rig it cannot reach and skips; a floor above zero refuses the developer who has no rigs up, so what this step must not do is call that ok',
    },
  },
  {
    id: 'conformance',
    tier: 'integration',
    run: nodeTest(CONFORMANCE_FILES),
    evidence: testCounts,
    floor: {
      ran: 0,
      why: 'the cross-engine suites skip the engines this run cannot reach, by name, one test at a time',
    },
  },
  {
    id: 'adversarial',
    tier: 'integration',
    run: nodeTest(ADVERSARIAL_FILES),
    evidence: testCounts,
    floor: {
      ran: 0,
      why: 'the hostile suites skip the engines this run cannot reach, by name, one test at a time',
    },
  },
  {
    id: 'prove',
    tier: 'integration',
    run: nodeTest(PROVE_FILES),
    evidence: testCounts,
    floor: {
      ran: 0,
      why: 'the differential skips an unreachable backend by name rather than failing, so the number that ran is the number of rigs this host has',
    },
  },
  {
    id: 'fuzz',
    tier: 'integration',
    run: nodeTest(FUZZ_FILES),
    evidence: testCounts,
    floor: {
      ran: 1,
      why: 'an unreachable backend is recorded inside the run and reported by the suite itself, so nothing here skips',
    },
  },
  // A scaffolded project served against a real engine needs the rigs, which is what puts it in
  // this tier rather than beside the walk: CI runs `integration` in the job that has them, and
  // `acceptance` in the one that does not.
  {
    id: 'rigs',
    tier: 'integration',
    run: nodeTest(RIG_FILES),
    evidence: testCounts,
    floor: {
      ran: 0,
      why: 'a scaffolded project is served against whichever rigs this run can reach, and skips the rest by name',
    },
  },

  {
    id: 'walk',
    tier: 'acceptance',
    run: nodeTest(ACCEPTANCE_FILES),
    evidence: testCounts,
    floor: {
      ran: 1,
      why: 'the walk packs, installs and drives the scaffolder out of this checkout and needs nothing else; ECONOMY_SKIP_WALK=1 is the one way out of it and no gate sets it',
    },
  },
  {
    id: 'smoke',
    tier: 'acceptance',
    run: nodeTest(SMOKE_FILES),
    evidence: testCounts,
    floor: {
      ran: 0,
      why: 'the optional adapters against their real services: the live job supplies redis and localstack and the apps job does not, so a leg without its service skips naming the port it wanted',
    },
  },
  { id: 'samples', tier: 'acceptance', run: ['npm', 'run', 'check:samples'] },
  // The repository's own economy, run the way it ships: `economy serve` over economy/, inside the
  // image, answering its health check.
  {
    id: 'image',
    tier: 'acceptance',
    run: [process.execPath, 'scripts/check/image.ts'],
    needs: dockerDaemon,
    evidence: imageAnswer,
  },
  {
    id: 'console:verify',
    tier: 'acceptance',
    run: ['npm', 'run', 'verify', '--prefix', 'apps/console'],
  },
  {
    id: 'console:budget',
    tier: 'acceptance',
    run: ['npm', 'run', 'budget', '--prefix', 'apps/console'],
  },
  {
    id: 'docs:verify',
    tier: 'acceptance',
    run: ['npm', 'run', 'verify', '--prefix', 'apps/docs'],
  },
  {
    id: 'docs:ref',
    tier: 'acceptance',
    run: ['npm', 'run', 'check:ref', '--prefix', 'apps/docs'],
    needs: committedTree,
  },
  // The two gates below read what this build writes, and nothing else does.
  {
    id: 'docs:build',
    tier: 'acceptance',
    run: ['npm', 'run', 'build', '--prefix', 'apps/docs'],
  },
  {
    id: 'docs:csp',
    tier: 'acceptance',
    run: ['npm', 'run', 'check:csp', '--prefix', 'apps/docs'],
  },
  {
    id: 'docs:static',
    tier: 'acceptance',
    run: ['npm', 'run', 'check:static', '--prefix', 'apps/docs'],
  },
  // Last in the tier, because it composes what the three steps above build. `dist-site/` is what
  // pages.yml deploys, and before this row nothing in the table read it.
  {
    id: 'site',
    tier: 'acceptance',
    run: [process.execPath, 'scripts/check/site.ts'],
    needs: composedInputs,
    evidence: siteAnswer,
  },
];

/**
 * Edited deliberately when a row is added or removed. A dropped row leaves `ran === selected`
 * true — both fall by one — so the count that catches it has to be declared apart from the table.
 */
export const DECLARED_STEPS = 29;

interface Outcome {
  readonly id: string;
  /**
   * `partial` is a pass that says so: the step ran, everything that ran passed, and part of it
   * did not run. It is not `ok`, because a step reporting `ok` over five tests and over three of
   * five tells a reader nothing about which one they got.
   */
  readonly state: 'ok' | 'partial' | 'failed' | 'skipped';
  readonly note: string;
}

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** How many distinct things a shortfall names before it counts the rest. */
const NAMED_NEEDS = 3;

/** The step line's tail for a run that did not run whole, and the floor it was held to. */
function shortfall(ran: Ran, floor: Floor): string {
  const clause = (label: string, reasons: readonly string[]): string[] => {
    if (reasons.length === 0) return [];
    const rest = reasons.length - NAMED_NEEDS;
    const said = reasons.slice(0, NAMED_NEEDS).join('; ');
    return [`${label} ${said}${rest > 0 ? `, and ${rest} more` : ''}`];
  };
  const said = [
    ...clause('needs', ran.needed),
    ...clause('pending', ran.pending),
  ];
  const suites =
    ran.suites > 0 ? `, and ${ran.suites} suite(s) never registered` : '';
  return `${ran.ran} of ${ran.tests} ran (floor ${percent(floor.ran)})${suites} — ${said.length > 0 ? said.join(' · ') : 'and no directive said why'}`;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * The files a step runs that load the lab out of its emit rather than out of `src/`. A step
 * selected on its own skips `fresh:dist`, which is how a mutation proof run against one row can
 * report a green that describes the previous build.
 */
function readsEmit(step: CheckStep): Dated {
  const files = step.run.filter((arg) => arg.endsWith('.test.ts'));
  if (files.length === 0) return { dated: false, refusal: null };
  const reaching = reachesDist(ROOT, files);
  if (reaching.length === 0) return { dated: false, refusal: null };
  try {
    assertBuildsFresh(ROOT, `the ${step.id} step`);
  } catch (refusal) {
    const shown = reaching.slice(0, 3).map(describeReach).join('\n  ');
    return {
      dated: false,
      refusal: `${(refusal as Error).message}\n${reaching.length} of this step's files read that emit:\n  ${shown}`,
    };
  }
  return { dated: true, refusal: null };
}

/** Whether this step's emit was dated here, and why it was refused when it was. */
interface Dated {
  readonly dated: boolean;
  readonly refusal: string | null;
}

function execute(step: CheckStep): Outcome {
  const emit = readsEmit(step);
  if (emit.refusal !== null) {
    process.stdout.write('FAIL\n');
    console.error(`  ${emit.refusal}`);
    return { id: step.id, state: 'failed', note: 'runs against a stale emit' };
  }

  // node --test exports NODE_TEST_CONTEXT to children, and a child that inherits it exits 0
  // whatever its tests did. An empty string still counts as set, so it is deleted.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // The dating above covers every file this step is about to run, so the guard each of them
  // imports has nothing left to do. Set only when it actually happened.
  if (emit.dated) env[BUILDS_DATED] = '1';

  const [command, ...args] = step.run;
  const started = Date.now();
  const run = spawnSync(command!, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: STEP_TIMEOUT_MS,
  });
  const took = seconds(Date.now() - started);
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;

  if (run.error !== undefined || run.status === null) {
    process.stdout.write(`FAIL ${took}\n`);
    console.error(
      `  ${step.run.join(' ')} never completed within ${STEP_TIMEOUT_MS}ms`,
    );
    return { id: step.id, state: 'failed', note: 'did not complete' };
  }

  let note = took;
  let ran: Ran | undefined;
  try {
    if (step.evidence) {
      const evidence = step.evidence(output, step);
      note = `${took} — ${evidence.note}`;
      ran = evidence.ran;
    }
  } catch (blind) {
    process.stdout.write(`FAIL ${took}\n`);
    console.error(`  ${(blind as Error).message}`);
    console.error(output.slice(-2000));
    return { id: step.id, state: 'failed', note: (blind as Error).message };
  }

  if (run.status !== 0) {
    process.stdout.write(`FAIL ${note}\n`);
    console.error(output.slice(-4000));
    return { id: step.id, state: 'failed', note };
  }

  const held = ran === undefined ? null : heldToItsFloor(step, ran);
  if (held !== null) {
    const said = `${note} · ${held.said}`;
    if (held.state === 'failed') {
      process.stdout.write(`FAIL ${note}\n`);
      console.error(`  ${held.said}`);
    } else {
      process.stdout.write(`partial ${said}\n`);
    }
    return { id: step.id, state: held.state, note: said };
  }

  process.stdout.write(`ok ${note}\n`);
  return { id: step.id, state: 'ok', note };
}

/**
 * How much of a step ran, against how much of it had to. Null when it ran whole, which is the
 * only run that may print `ok`; otherwise the verdict and the line that says why. Every step that
 * counts tests declares a floor, so this is not reached without one.
 */
export function heldToItsFloor(
  step: CheckStep,
  ran: Ran,
): { readonly state: 'partial' | 'failed'; readonly said: string } | null {
  const floor = step.floor;
  if (floor === undefined) return null;
  // A suite skipped whole is a failure only where the floor is the whole step, because there it
  // is exactly what was promised and exactly what did not happen.
  const under =
    ran.ran / ran.tests < floor.ran || (ran.suites > 0 && floor.ran === 1);
  if (under) {
    return {
      state: 'failed',
      said: `${shortfall(ran, floor)}\n  ${step.id} must run ${percent(floor.ran)} of its own tests: ${floor.why}`,
    };
  }
  if (ran.ran < ran.tests || ran.suites > 0) {
    return { state: 'partial', said: shortfall(ran, floor) };
  }
  return null;
}

/** A selector is one tier or one step id. Anything else names nothing and is refused. */
function select(selector: string | undefined): readonly CheckStep[] {
  if (selector === undefined) return STEPS;
  if ((TIERS as readonly string[]).includes(selector)) {
    return STEPS.filter((step) => step.tier === selector);
  }
  return STEPS.filter((step) => step.id === selector);
}

const USAGE = `usage: node scripts/check.ts [tier|step]

  tiers  ${TIERS.join(' ')}
  steps  ${STEPS.map((step) => step.id).join(' ')}

With no argument the whole table runs. Every step runs even after one fails, so a second
failure is not hidden by the first.`;

function main(argv: readonly string[]): number {
  if (STEPS.length !== DECLARED_STEPS) {
    console.error(
      `check: the table holds ${STEPS.length} steps and declares ${DECLARED_STEPS}`,
    );
    return 2;
  }
  if (argv.length > 1) {
    console.error(USAGE);
    return 2;
  }

  const selected = select(argv[0]);
  if (selected.length === 0) {
    console.error(`check: "${argv[0]}" selects no step\n\n${USAGE}`);
    return 2;
  }

  const outcomes: Outcome[] = [];
  try {
    for (const step of selected) {
      const missing = step.needs?.() ?? null;
      if (missing !== null) {
        process.stdout.write(`skip ${step.id} — needs ${missing}\n`);
        outcomes.push({ id: step.id, state: 'skipped', note: missing });
        continue;
      }
      process.stdout.write(`${step.id} ... `);
      outcomes.push(execute(step));
    }
  } finally {
    // The reconciliation, in a finally so a step that escapes the loop still says how far the run
    // got. Reported steps short of selected steps is a refusal however the run ended.
    if (outcomes.length !== selected.length) {
      console.error(
        `check: selected ${selected.length} steps and ${outcomes.length} reported`,
      );
    }
  }
  if (outcomes.length !== selected.length) return 2;

  const of = (state: Outcome['state']): Outcome[] =>
    outcomes.filter((outcome) => outcome.state === state);
  const failed = of('failed');
  const partial = of('partial');
  const skipped = of('skipped');
  const line = `check: ${selected.length} of ${STEPS.length} steps — ${of('ok').length} ok, ${partial.length} partial, ${failed.length} failed, ${skipped.length} skipped`;
  // Named, because "partial" in a headline is a number nobody can act on. These are the steps
  // that ran and proved less than the whole of themselves.
  const short =
    partial.length > 0
      ? `\npartial: ${partial.map((each) => each.id).join(' ')}`
      : '';
  if (failed.length > 0) {
    console.error(
      `${line}${short}\nfailed: ${failed.map((f) => f.id).join(' ')}`,
    );
    return 1;
  }
  process.stdout.write(`${line}${short}\n`);
  return 0;
}

// Imported by the gate test for its table; only a direct invocation runs anything.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
