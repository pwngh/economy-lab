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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { getFileInfo } from 'prettier';

import {
  ACCEPTANCE_FILES,
  ADVERSARIAL_FILES,
  ALL_TEST_FILES,
  CONFORMANCE_FILES,
  DECLARED_STEPS,
  ENGINE_FILES,
  FUZZ_FILES,
  PROPERTY_FILES,
  heldToItsFloor,
  PROVE_FILES,
  RIG_FILES,
  SMOKE_FILES,
  STEPS,
  SUITE_FILES,
  TIERS,
} from '#scripts/check.ts';

import type { CheckStep, Ran } from '#scripts/check.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const manifest = (dir: string): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

// The table, pinned. `steps run === steps declared` cannot catch a deleted row — both sides fall
// by one — so the roster that catches it is written down apart from the table and edited to a new
// exact value when a gate is added or retired.
const ROSTER: Readonly<Record<string, string>> = {
  'fresh:dist': 'static',
  'fresh:docs': 'static',
  'node-floor': 'static',
  typecheck: 'static',
  lint: 'static',
  format: 'static',
  trace: 'static',
  browser: 'static',
  suite: 'unit',
  property: 'unit',
  packages: 'unit',
  engines: 'integration',
  conformance: 'integration',
  adversarial: 'integration',
  prove: 'integration',
  fuzz: 'integration',
  rigs: 'integration',
  walk: 'acceptance',
  smoke: 'acceptance',
  samples: 'acceptance',
  image: 'acceptance',
  'console:verify': 'acceptance',
  'console:budget': 'acceptance',
  'docs:verify': 'acceptance',
  'docs:ref': 'acceptance',
  'docs:build': 'acceptance',
  'docs:csp': 'acceptance',
  'docs:static': 'acceptance',
  site: 'acceptance',
};

test('the step table is exactly the declared roster', () => {
  assert.deepEqual(
    Object.fromEntries(STEPS.map((step) => [step.id, step.tier])),
    ROSTER,
  );
  assert.equal(STEPS.length, Object.keys(ROSTER).length);
  assert.equal(
    STEPS.length,
    DECLARED_STEPS,
    'scripts/check.ts declares a step count its own table does not hold',
  );
  assert.deepEqual([...new Set(STEPS.map((step) => step.id))].length, 29);
  assert.deepEqual(
    [...new Set(STEPS.map((step) => step.tier))].sort(),
    [...TIERS].sort(),
  );
});

/** What a step's argv resolves to on disk, or the reason it resolves to nothing. */
function unresolved(step: CheckStep): string[] {
  const [command, ...args] = step.run;
  if (command === 'npm') {
    assert.equal(args[0], 'run', `${step.id}: only \`npm run\` is a step`);
    const at = args.indexOf('--prefix');
    const dir = at === -1 ? '.' : args[at + 1]!;
    const scripts = manifest(dir).scripts ?? {};
    return args[1]! in scripts ? [] : [`${dir} has no "${args[1]}" script`];
  }
  return args
    .filter((arg) => !arg.startsWith('--'))
    .filter((arg) => !existsSync(join(ROOT, arg)))
    .map((arg) => `${arg} does not exist`);
}

test('every step names a command that exists', () => {
  const broken = STEPS.flatMap((step) =>
    unresolved(step).map((why) => `${step.id}: ${why}`),
  );
  assert.deepEqual(broken, []);
  // A gate whose argv matched nothing would pass every assertion above it.
  assert.equal(STEPS.length, 29, 'the sweep read a table of a different size');
});

// The root `test` script and the table both claim to name the whole suite. They are two readings
// of one set, so they are reconciled here rather than trusted to agree.
test('the file steps partition every test file, and nothing else defines that set', () => {
  assert.match(
    manifest('.').scripts!.test!,
    /"test\/\*\*\/\*\.test\.ts"/,
    'npm test no longer globs test/**/*.test.ts, so the table walks a different set',
  );

  const rosters = [
    SUITE_FILES,
    PROPERTY_FILES,
    CONFORMANCE_FILES,
    ADVERSARIAL_FILES,
    ENGINE_FILES,
    ACCEPTANCE_FILES,
    RIG_FILES,
    SMOKE_FILES,
    PROVE_FILES,
    FUZZ_FILES,
  ];
  const claimed = rosters.flat();
  assert.equal(
    claimed.length,
    new Set(claimed).size,
    'a test file is claimed by two steps and would run twice',
  );
  assert.deepEqual([...claimed].sort(), [...ALL_TEST_FILES].sort());

  // Exact, because a roster that quietly empties still satisfies a partition.
  assert.deepEqual(
    rosters.map((roster) => roster.length),
    [168, 6, 6, 2, 1, 1, 1, 1, 1, 1],
  );
  assert.equal(ALL_TEST_FILES.length, 188);
});

test('every test file the table runs still exists', () => {
  const missing = ALL_TEST_FILES.filter(
    (file) => !existsSync(join(ROOT, file)),
  );
  assert.deepEqual(missing, []);
});

/** Every `.ts`/`.tsx` under a directory, repo-relative and posix-separated. */
function authored(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return authored(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    },
  );
}

/**
 * The `lint` and `format` steps run `eslint .` and `prettier -c .`, so what they examine is
 * whatever their ignore files leave. An entry that exempts an authored file takes it out of two
 * of the five static-tier steps while the table still reports both green, and `prettier -c` on an
 * ignored path prints "All matched files use Prettier code style!" having opened nothing. So the
 * question is asked of each tool's own resolver rather than of the config text, for every file
 * under `src/` and every test file the table runs.
 */
test('lint and format govern every authored source file', async () => {
  const eslint = new ESLint({});
  const governed = async (file: string): Promise<string[]> => {
    const reasons: string[] = [];
    if (await eslint.isPathIgnored(file)) reasons.push('eslint');
    const info = await getFileInfo(file, { ignorePath: '.prettierignore' });
    if (info.ignored) reasons.push('prettier');
    return reasons;
  };

  // A generated path both tools do ignore. Without it a resolver that answered "governed" to
  // everything would satisfy every assertion below.
  assert.deepEqual(await governed('dist/src/index.js'), ['eslint', 'prettier']);

  const src = authored('src');
  assert.equal(src.length, 106, 'src/ file count moved; re-derive and re-pin');

  const files = [...src, ...ALL_TEST_FILES];
  const exempt: Record<string, string[]> = {};
  for (const file of files) {
    const reasons = await governed(file);
    if (reasons.length > 0) exempt[file] = reasons;
  }
  assert.deepEqual(exempt, {});

  // The test half is the pinned roster above, resolved here rather than counted twice.
  assert.equal(files.length, 106 + ALL_TEST_FILES.length);
});

interface Workflow {
  readonly jobs: readonly string[];
  readonly runs: readonly string[];
}

function workflow(name: string): Workflow {
  const path = join(ROOT, '.github', 'workflows', name);
  const lines = readFileSync(path, 'utf8').split('\n');
  const jobs: string[] = [];
  const runs: string[] = [];
  let inJobs = false;
  for (const line of lines) {
    if (line === 'jobs:') inJobs = true;
    const job = /^ {2}([A-Za-z][\w-]*):$/.exec(line);
    if (inJobs && job !== null) jobs.push(job[1]!);
    const run = /^\s*- run: (.+)$/.exec(line);
    if (run === null) continue;
    assert.doesNotMatch(
      run[1]!,
      /^[|>]/,
      `${name}: a block \`run:\` is invisible to this reader`,
    );
    runs.push(run[1]!.trim());
  }
  assert.ok(jobs.length > 0, `${name}: read no jobs`);
  return { jobs, runs };
}

/**
 * The only `run:` steps ci.yml may carry that are not the gate. Each puts something on the disk
 * that a gate then reads; none of them decides whether the tree is green.
 */
const SETUP: Readonly<Record<string, string>> = {
  'npm ci': 'installs the root workspace',
  'npm ci --prefix apps/console': "installs the console's own toolchain",
  'npm ci --prefix apps/docs': "installs the docs' own toolchain",
  'npm run build': "builds the lab's dist, which is gitignored",
  'npm run build:packages': "builds the packages' dist, also gitignored",
  'npm run docs:api': 'generates the reference every ApiLink resolves into',
  'npm run db:migrate': 'applies the Postgres schema to the service container',
  'npm run db:clean': 'sweeps the throwaway namespaces the run orphaned',
};

/**
 * The steps `ci.yml` names one at a time instead of by tier, each with the reason it is not
 * reached by the job that runs its tier. Both are in `acceptance`, which the `apps` job runs
 * without a single service container, so both run there having proven the half of themselves that
 * needs nothing: the smoke's HTTP leg, and the image on the in-memory store. The `live` job runs
 * the same two rows against real services.
 *
 * Pinned as an exact roster, because "a step id is allowed here" is the loophole a gate list could
 * be rebuilt through one row at a time.
 */
const BY_STEP: Readonly<Record<string, string>> = {
  smoke:
    'the redis and SQS legs need a service container the apps job has not got',
  image: 'the deployment posture needs a database the apps job has not got',
};

test('ci.yml runs the table and nothing else', () => {
  const { jobs, runs } = workflow('ci.yml');
  assert.deepEqual(jobs, ['check', 'apps', 'matrix', 'live']);

  const gates = runs.filter((run) => run.startsWith('npm run check'));
  const rest = runs.filter((run) => !run.startsWith('npm run check'));
  const unexplained = rest.filter((run) => !(run in SETUP));
  assert.deepEqual(
    unexplained,
    [],
    'a gate was added to ci.yml instead of to scripts/check.ts',
  );

  // Every gate command names something the table holds — a tier, or one of the two steps above.
  // Every tier is run by some job, so a tier that no job invokes is declared and never gated; and
  // a step named directly must be a real step and must be on the roster with its reason.
  const invoked = gates.map((run) => run.replace('npm run check ', ''));
  const tiers = invoked.filter((name) =>
    (TIERS as readonly string[]).includes(name),
  );
  const steps = invoked.filter(
    (name) => !(TIERS as readonly string[]).includes(name),
  );
  assert.deepEqual([...new Set(tiers)].sort(), [...TIERS].sort());
  assert.deepEqual([...new Set(steps)].sort(), Object.keys(BY_STEP).sort());
  for (const id of steps) {
    assert.ok(
      STEPS.some((step) => step.id === id),
      `${id} is neither a tier nor a step in the table`,
    );
  }
  assert.equal(runs.length, 25, 'ci.yml holds a different number of steps');
});

/**
 * The `live` job's whole value is what it supplies, and neither of its two steps fails without it:
 * `smoke` skips the legs whose service is absent, and `image` boots the memory store when no
 * `DATABASE_URL` names an engine. Delete the services block or the env block and the job stays
 * green having become a second, slower copy of what the `apps` job already ran.
 *
 * So the job is held to its own supply, both ways: each service container, and the env name that
 * points a step at it.
 */
const LIVE_SUPPLY: ReadonlyMap<string, string> = new Map([
  ['postgres:', 'DATABASE_URL:'],
  ['redis:', 'REDIS_URL:'],
  ['localstack:', 'AWS_ENDPOINT_URL:'],
]);

test('the live job supplies every service its two steps need', () => {
  const text = readFileSync(
    join(ROOT, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const at = text.indexOf('\n  live:\n');
  assert.ok(at > 0, 'ci.yml has no live job');
  const job = text.slice(at);
  // The job is last, so its text runs to the end of the file; a job added after it would have to
  // move this reader deliberately rather than silently shrink what it examines.
  assert.ok(
    job.split('\n').filter((line) => /^ {2}[A-Za-z][\w-]*:$/.test(line))
      .length === 1,
    'the live job is no longer last in ci.yml, so this reader spans more than it names',
  );

  const missing: string[] = [];
  for (const [service, variable] of LIVE_SUPPLY) {
    if (!job.includes(`\n      ${service}\n`)) missing.push(service);
    if (!job.includes(`\n      ${variable} `)) missing.push(variable);
  }
  assert.deepEqual(
    missing,
    [],
    'the live job lost a service or the env name that points a step at it',
  );
  assert.equal(LIVE_SUPPLY.size, 3, 'the supply roster read a different size');
  // Every service carries a health gate: an unhealthy container fails the job, and one with no
  // health command is declared ready the moment it is created, which is a race, not a service.
  assert.equal(
    [...job.matchAll(/--health-cmd/g)].length,
    3,
    'a service container in the live job has no health command',
  );
});

/**
 * The other three workflows, each pinned to an exact list. Two of them held their own copy of the
 * gate list before this: pages.yml ran six app gates by hand, with no build in front of them, and
 * ci.sh ran a tenth of a chain nobody counted.
 */
const OTHER_WORKFLOWS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'pages.yml',
    [
      'npm ci',
      'npm ci --prefix apps/docs',
      'npm ci --prefix apps/console',
      'npm run build',
      'npm run build:packages',
      'npm run docs:api',
      // Before the gates, so the acceptance tier's `site` step has every input on disk: the
      // composed artifact is a row of the table now, and the two inline gate steps that used to
      // check it here are gone.
      'npm run site',
      'npm run check acceptance',
      'rm -f dist-site/_headers dist-site/_redirects',
    ],
  ],
  [
    // The soak is workflow_dispatch plus a nightly cron and never a push gate; the bench it runs
    // is not a gate and is in no tier. The two builds are its preconditions, not gates: the bench
    // reaches its engines through packages whose exports point at a gitignored dist/. The second
    // job runs the four standalone instruments at the fast profile, so an entry point nothing
    // else executes still runs nightly — the roster half of that claim is
    // test/tsconfig-coverage.test.ts's cadence gate.
    'soak.yml',
    [
      'npm ci',
      'npm run build',
      'npm run build:packages',
      'npm run db:migrate',
      'npm run bench',
      'BENCH_MODE=contention npm run bench',
      'npm run db:clean',
      'npm ci',
      'npm run build',
      'npm run build:packages',
      'npm run bench:wire',
      'npm run bench:profile',
      'npm run bench:multinode',
      'npm run bench:scale',
    ],
  ],
  [
    // `npm publish` fires prepublishOnly, which builds both emits and runs the whole table, so
    // the two app installs above it are that table's preconditions rather than gates of its own.
    'publish.yml',
    [
      'npm ci',
      'npm ci --prefix apps/console',
      'npm ci --prefix apps/docs',
      'git tag --points-at HEAD | grep -qx "v$(node -p "require(\'./package.json\').version")"',
      'npm publish --provenance --access public',
    ],
  ],
]);

for (const [name, expected] of OTHER_WORKFLOWS) {
  test(`${name} holds no second copy of the gate list`, () => {
    assert.deepEqual(workflow(name).runs, expected);
  });
}

test('the gate has one entry point', () => {
  assert.ok(
    !existsSync(join(ROOT, 'scripts', 'ci.sh')),
    'scripts/ci.sh is back, and it is a hand-kept copy of ci.yml',
  );
  const scripts = manifest('.').scripts!;
  assert.equal(scripts.check, 'node scripts/check.ts');
  assert.equal(
    scripts.prop,
    'node scripts/check.ts property',
    'the property step has a second definition',
  );
  assert.equal(
    scripts.smoke,
    'node scripts/check.ts smoke',
    'the smoke step has a second definition',
  );
  assert.equal(
    scripts.prepublishOnly,
    'npm run build && npm run build:packages && npm run check',
    'publishing gates on something other than the table',
  );
  assert.match(
    readFileSync(join(ROOT, 'Makefile'), 'utf8'),
    /^ci:\s+; npm run check$/m,
    'make ci points somewhere other than the table',
  );
});

/**
 * A TAP summary as `node --test --test-reporter=tap` prints it, with the accounting line the
 * counted reporter prints beside it. Both are what a step reads, so both are what a fixture here
 * has to carry; `counted` defaults to agreeing with the TAP totals.
 */
function tap(
  counts: Readonly<Record<string, number>>,
  extra: {
    readonly counted?: string | null;
    readonly files?: number;
    readonly lines?: string;
  } = {},
): string {
  const totals = Object.entries(counts)
    .map(([field, n]) => `# ${field} ${n}`)
    .join('\n');
  const skip = (counts.skipped ?? 0) + (counts.todo ?? 0);
  const accounting =
    extra.counted === null
      ? ''
      : (extra.counted ??
        `counted: ${extra.files ?? 1} files, ${counts.tests ?? 0} tests, ${counts.pass ?? 0} pass, ${counts.fail ?? 0} fail, ${skip} skip`);
  return `${extra.lines ?? ''}${totals}\n${accounting}\n`;
}

/** A step that names one test file, which is what the fixtures above claim to have run. */
const oneFile: CheckStep = {
  id: 'one-file',
  tier: 'unit',
  run: ['node', '--test', 'test/one.test.ts'],
};

/**
 * The evidence function ten of the table's steps share, and until `Q53` S6 nothing tested it. Its
 * refusals are the ones an exit code cannot make: a runner that printed no counts, one that
 * matched no file, one whose file was cancelled by `--test-timeout` — which TAP reports as
 * `cancelled`, never `fail`, so the step would otherwise print "0 fail" beside its own timeout —
 * and, since `Q365`, a run whose files did not add up to what the run says they did.
 */
test('every file step refuses a runner that reported on nothing', () => {
  const counted = STEPS.filter((step) => step.run.includes('--test'));
  assert.equal(
    counted.length,
    10,
    'the table runs a different number of node --test steps',
  );
  for (const step of counted) {
    assert.ok(step.evidence, `${step.id} runs node --test and counts nothing`);
  }
  const evidence = counted[0]!.evidence!;
  // One function, shared by all ten — asserted rather than assumed, because a per-step copy is
  // where one of them quietly stops refusing.
  for (const step of counted) assert.equal(step.evidence, evidence);

  assert.deepEqual(
    evidence(tap({ tests: 9, pass: 8, fail: 1, skipped: 0, todo: 0 }), oneFile),
    {
      note: '9 tests, 8 pass, 1 fail, 0 skip, 0 todo',
      ran: { tests: 9, ran: 9, suites: 0, needed: [], pending: [] },
    },
  );
  assert.throws(
    () => evidence('ok 1 - something\n', oneFile),
    /reported on nothing/,
    'a runner that printed no counts passed',
  );
  assert.throws(
    () => evidence(tap({ tests: 0, pass: 0, fail: 0 }), oneFile),
    /matched no tests/,
    'a runner whose glob matched nothing passed',
  );
  assert.throws(
    () => evidence(tap({ tests: 9, pass: 0, fail: 0, cancelled: 9 }), oneFile),
    /were cancelled/,
    'a file killed by the test timeout read as nine tests and no failures',
  );
});

/**
 * `Q365`. TAP's totals are computed once every child has ended, so a file that ended its own
 * process is counted there as one passing test. The step reads a second number beside them —
 * what the files themselves reported — and these are the ways the two can fail to line up.
 */
test('every file step refuses a run its files do not add up to', () => {
  const evidence = STEPS.find((step) => step.id === 'suite')!.evidence!;
  const counts = { tests: 9, pass: 9, fail: 0, skipped: 0, todo: 0 };

  assert.throws(
    () => evidence(tap(counts, { counted: null }), oneFile),
    /no accounting line/,
    'a run the counted reporter never reported on passed',
  );
  assert.throws(
    () =>
      evidence(
        tap(counts, {
          counted: 'counted: 1 files, 7 tests, 7 pass, 0 fail, 0 skip',
        }),
        oneFile,
      ),
    /a file that left the run is counted whole in the first/,
    'a run whose files reported two fewer tests than the run did passed',
  );
  assert.throws(
    () => evidence(tap(counts, { files: 2 }), oneFile),
    /1 test file\(s\) were named on the command line and 2 reported/,
    'a run that reported on more files than it was given passed',
  );
});

/**
 * `Q83`, and `Q381`'s half of it: a skip states the capability it needs, and a suite skipped
 * whole is missing from every count TAP prints — `describe(…, { skip })` around two tests reports
 * one skip line and no tests at all.
 *
 * A todo is read on the same rule. It withholds a test as completely as a skip and is subtracted
 * from `ran` the same way, so a step short of itself for todos alone has to say what they were:
 * `adversarial` reported `partial — needs` with nothing after it, over four todos that each name
 * their reason.
 */
test('a step reads what its skips and todos withheld, and sees a suite that never registered', () => {
  const evidence = STEPS.find((step) => step.id === 'suite')!.evidence!;
  const skipped = (line: string, counts: Record<string, number>) =>
    evidence(tap(counts, { lines: `${line}\n` }), oneFile).ran!;

  assert.deepEqual(
    skipped('ok 2 - needs redis # SKIP no redis at 127.0.0.1:6379', {
      tests: 3,
      pass: 2,
      fail: 0,
      skipped: 1,
      todo: 0,
    }),
    {
      tests: 3,
      ran: 2,
      suites: 0,
      needed: ['no redis at 127.0.0.1:6379'],
      pending: [],
    },
  );
  assert.deepEqual(
    skipped('ok 2 - conservation # TODO not enforced on memory: oracle only', {
      tests: 3,
      pass: 3,
      fail: 0,
      skipped: 0,
      todo: 1,
    }),
    {
      tests: 3,
      ran: 2,
      suites: 0,
      needed: [],
      pending: ['not enforced on memory: oracle only'],
    },
  );
  // The count says three ran and three passed, and one suite's worth of tests was never
  // registered to be counted at all.
  assert.deepEqual(
    skipped('ok 4 - the whole walk # SKIP ECONOMY_SKIP_WALK=1', {
      tests: 3,
      pass: 3,
      fail: 0,
      skipped: 0,
      todo: 0,
    }),
    {
      tests: 3,
      ran: 3,
      suites: 1,
      needed: ['ECONOMY_SKIP_WALK=1'],
      pending: [],
    },
  );
  assert.throws(
    () =>
      skipped('ok 2 - a test that skipped # SKIP', {
        tests: 3,
        pass: 2,
        fail: 0,
        skipped: 1,
        todo: 0,
      }),
    /held back by SKIP without naming why/,
    'a skip naming nothing passed',
  );
  assert.throws(
    () =>
      skipped('ok 2 - a test left pending # TODO', {
        tests: 3,
        pass: 3,
        fail: 0,
        skipped: 0,
        todo: 1,
      }),
    /held back by TODO without naming why/,
    'a todo naming nothing passed',
  );
});

/**
 * The verdict itself. `ok` is reserved for a step that ran whole; a step that ran short of its
 * floor fails, and a step short of the whole thing but above its floor is `partial` — the word
 * `Q381` is about, because without it the table's headline reads the same either way.
 */
test('a step that ran short of itself does not report ok', () => {
  const step = STEPS.find((each) => each.id === 'smoke')!;
  const whole = STEPS.find((each) => each.id === 'walk')!;
  const ran = (over: Partial<Ran>): Ran => ({
    tests: 5,
    ran: 5,
    suites: 0,
    needed: [],
    pending: [],
    ...over,
  });

  assert.equal(heldToItsFloor(step, ran({})), null, 'a whole run is not ok');
  assert.equal(
    heldToItsFloor(step, ran({ ran: 3, needed: ['redis'] }))?.state,
    'partial',
  );
  assert.match(
    heldToItsFloor(step, ran({ ran: 3, needed: ['redis'] }))!.said,
    /3 of 5 ran \(floor 0%\) — needs redis/,
  );
  // A step short of itself for todos alone: the verdict is the same and the line names them,
  // rather than printing `needs` with nothing after it.
  assert.match(
    heldToItsFloor(step, ran({ ran: 3, pending: ['memory is the oracle'] }))!
      .said,
    /3 of 5 ran \(floor 0%\) — pending memory is the oracle$/,
  );
  assert.match(
    heldToItsFloor(
      step,
      ran({ ran: 3, needed: ['redis'], pending: ['memory is the oracle'] }),
    )!.said,
    /— needs redis · pending memory is the oracle$/,
  );
  // The floor, fired: the same run under a step that must run all of itself.
  assert.equal(
    heldToItsFloor(whole, ran({ ran: 3, needed: ['redis'] }))?.state,
    'failed',
  );
  // A suite skipped whole registers no tests at all, so every count says the step ran whole.
  assert.equal(heldToItsFloor(step, ran({ suites: 1 }))?.state, 'partial');
  assert.equal(heldToItsFloor(whole, ran({ suites: 1 }))?.state, 'failed');
  assert.match(
    heldToItsFloor(whole, ran({ suites: 1 }))!.said,
    /1 suite\(s\) never registered/,
  );
});

/**
 * `Q381`. `ok — 5 pass, 0 skip` and `ok — 3 pass, 2 skip` were the same verdict word, so the
 * table's headline could not tell a step that ran from one that mostly did not. Every step that
 * counts tests now declares how much of itself has to run, and a floor short of the whole step
 * carries the reason it is short.
 */
test('every step that counts tests declares a floor, and says why', () => {
  const counting = STEPS.filter((step) => step.run.includes('--test'));
  for (const step of counting) {
    const floor = step.floor;
    assert.ok(floor, `${step.id} counts tests and declares no floor`);
    assert.ok(
      floor.ran >= 0 && floor.ran <= 1,
      `${step.id} declares a floor of ${floor.ran}, which is not a share`,
    );
    assert.ok(
      floor.why.length > 40,
      `${step.id} declares a floor with no reason worth reading`,
    );
  }
  // Exact, so a step cannot quietly join the exempt end. The whole-step floors are the two that
  // reach no service; every other floor names the capability its tests skip for.
  assert.deepEqual(
    counting.filter((step) => step.floor!.ran === 1).map((step) => step.id),
    ['property', 'fuzz', 'walk'],
  );
  assert.deepEqual(
    STEPS.filter((step) => step.floor !== undefined).length,
    counting.length,
    'a step declares a floor and counts no tests, so nothing applies it',
  );
});

test('prove and fuzz have one definition each, and it is the table', () => {
  const scripts = manifest('.').scripts!;
  assert.equal(scripts.prove, 'node scripts/check.ts prove');
  assert.equal(scripts.fuzz, 'node scripts/check.ts fuzz');
  // Both were `scripts/` entry points signalling by exit code. A second definition here is how
  // `npm run prove` and the `prove` step drift into running different files.
  for (const id of ['prove', 'fuzz']) {
    const step = STEPS.find((s) => s.id === id)!;
    assert.deepEqual(
      step.run.filter((arg) => arg.startsWith('test/')),
      [`test/${id}.test.ts`],
      `the ${id} step runs something other than test/${id}.test.ts`,
    );
  }
});

/**
 * The two hand-kept spawns of the root freshness gates. Each app's vitest global setup spells
 * `node <repo>/scripts/check-*-fresh.ts` with its own directory as argv, and neither spelling is a
 * row in the table — so renaming a root gate reaches them through nothing. `Q53` S6 renamed both
 * and broke the docs one, which surfaced as a `MODULE_NOT_FOUND` inside vitest's global setup:
 * that reads as a docs defect rather than a moved file, and it cost a full table run to find.
 *
 * The population is swept off disk, so a third app's setup cannot appear unexamined, and every
 * spawned path must be a script the table itself runs — which is what makes this one reader
 * answer for both spawns and for the rows they shadow.
 */
function freshnessSetups(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.name === 'node_modules' || entry.name === 'build') return [];
      if (entry.isDirectory()) return freshnessSetups(path);
      return entry.name === 'freshness.setup.ts' ? [path] : [];
    },
  );
}

test('the apps’ freshness spawns name scripts the table runs', () => {
  const setups = freshnessSetups('apps').sort();
  // Exact, because a sweep that found nothing satisfies every assertion below it.
  assert.deepEqual(setups, [
    'apps/console/test/freshness.setup.ts',
    'apps/docs/freshness.setup.ts',
  ]);

  // What the table's two freshness rows run, read out of the table rather than typed again.
  const rows = STEPS.filter((step) => step.id.startsWith('fresh:')).map(
    (step) => step.run.find((arg) => arg.startsWith('scripts/'))!,
  );
  assert.deepEqual(rows, [
    'scripts/check-dist-fresh.ts',
    'scripts/check-docs-fresh.ts',
  ]);

  const spawned = setups.map((setup) => {
    const source = readFileSync(join(ROOT, setup), 'utf8');
    const paths = [...source.matchAll(/\$\{REPO\}([\w./-]+)/g)].map(
      (m) => m[1]!,
    );
    assert.equal(
      paths.length,
      1,
      `${setup} spawns ${paths.length} repository scripts, and this reader holds one`,
    );
    assert.ok(
      existsSync(join(ROOT, paths[0]!)),
      `${setup} spawns ${paths[0]}, which is not on disk — vitest reports that as MODULE_NOT_FOUND inside its global setup`,
    );
    return paths[0]!;
  });

  // Both ends: each spawn is a table row, and each row is spawned by an app. A gate renamed on one
  // side and not the other fails here rather than in a suite that reads as the app's own defect.
  assert.deepEqual([...spawned].sort(), [...rows].sort());
});

test('every step with a precondition names what it needs', () => {
  const gated = STEPS.filter((step) => step.needs !== undefined);
  assert.deepEqual(
    gated.map((step) => step.id),
    ['image', 'docs:ref', 'site'],
  );
  // The reason has to resolve, not just be present: on this tree each either runs or names a
  // capability, and "" would be a skip that names nothing.
  for (const step of gated) {
    const missing = step.needs!();
    assert.ok(
      missing === null || missing.length > 10,
      `${step.id} skipped without naming what it needs: ${String(missing)}`,
    );
  }
});
