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

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  crossPackageFindings,
  dependencyOrder,
  planDrift,
  publishPlan,
  readRootPackage,
  readWorkspace,
} from './support/workspace-graph.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const USAGE = `usage: node scripts/publish-packages.mjs [options]

Walks packages/ in dependency order. A dry run by default: nothing reaches the registry
unless --publish-for-real is on the command line.

  --publish-for-real   publish. Without it every step is npm publish --dry-run.
  --preflight-only     run the gates and stop before the first package.
  --allow-dirty        publish from a tree with uncommitted changes.
  --no-build           trust the dist directories already on disk.
  --files              list every path in each tarball, not just a per-directory count.
  --ignore-scripts     dry run only: pack from dist as it stands, without running each
                       package's own prepublishOnly. Surveys the whole release when one
                       package's gate is red. Never allowed with --publish-for-real.
  --tag=<dist-tag>     npm dist-tag to publish under (default latest).
  --registry=<url>     registry to read and publish to (default whatever npm resolves).
  --wait=<seconds>     how long to wait for a published version to become resolvable
                       before giving up (default 120).

A one-time password is never handled here. npm asks for it on this terminal, once per
package, or reads NPM_CONFIG_OTP itself — and one code does not outlive a whole run.`;

const DEFAULTS = {
  real: false,
  preflightOnly: false,
  allowDirty: false,
  build: true,
  files: false,
  ignoreScripts: false,
  help: false,
  tag: 'latest',
  registry: '',
  waitMs: 120_000,
};

function parseOptions(argv) {
  const options = { ...DEFAULTS };
  let sawDryRun = false;
  for (const arg of argv) {
    const at = arg.indexOf('=');
    const flag = at === -1 ? arg : arg.slice(0, at);
    const value = at === -1 ? '' : arg.slice(at + 1);
    if (flag === '--publish-for-real') options.real = true;
    else if (flag === '--dry-run') sawDryRun = true;
    else if (flag === '--preflight-only') options.preflightOnly = true;
    else if (flag === '--allow-dirty') options.allowDirty = true;
    else if (flag === '--no-build') options.build = false;
    else if (flag === '--files') options.files = true;
    else if (flag === '--ignore-scripts') options.ignoreScripts = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--tag') options.tag = value;
    else if (flag === '--registry') options.registry = value;
    else if (flag === '--wait') options.waitMs = Number(value) * 1000;
    else return { error: `unknown option "${arg}"` };
  }
  if (options.real && sawDryRun) {
    return { error: '--dry-run and --publish-for-real contradict each other' };
  }
  // Each package's prepublishOnly is its own release gate. Surveying without it is fine;
  // publishing without it is not.
  if (options.real && options.ignoreScripts) {
    return {
      error: '--ignore-scripts is a dry-run survey, never a way to publish',
    };
  }
  if (options.tag === '') return { error: '--tag needs a value' };
  if (!Number.isFinite(options.waitMs) || options.waitMs <= 0) {
    return { error: '--wait needs a number of seconds' };
  }
  return { options };
}

function capture(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const inherit = (command, args, cwd = ROOT) =>
  (spawnSync(command, args, { cwd, stdio: 'inherit' }).status ?? 1) === 0;

// npm's own code and status line, and nothing else. A full failure dump is noise, and no part
// of one belongs in a release log.
function summarize(stderr) {
  const lines = stderr
    .split('\n')
    .filter((line) => /^npm error (code \S+|\d{3} )/.test(line));
  return [...new Set(lines)].slice(0, 2).join('; ') || 'npm gave no reason';
}

const registryArgs = (options) =>
  options.registry === '' ? [] : [`--registry=${options.registry}`];

/**
 * What the registry says about one exact version. `absent` and `unknown` are different
 * answers: absent is a fact to act on, unknown is a reason to stop.
 */
function probe(name, version, options, fresh = false) {
  // npm retries a 5xx for over a minute before answering. This loop does its own waiting, and
  // an unhealthy registry has to be able to say so quickly.
  const args = [
    'view',
    `${name}@${version}`,
    'version',
    '--json',
    '--fetch-retries=0',
  ];
  args.push(...registryArgs(options));
  if (fresh) args.push('--prefer-online');
  const { status, stdout, stderr } = capture('npm', args);
  // npm answers E404 both for a name it has never seen and for a name at a version it does not
  // hold, so one clean exit carrying a version is the only yes. Everything else is not a no.
  if (status === 0 && stdout.trim() !== '') return 'published';
  if (/E404/.test(stderr + stdout)) return 'absent';
  return 'unknown';
}

/**
 * A version npm has accepted is not a version npm will resolve, and the gap has cost this
 * project a broken install before. Poll until it is really there, or say so and stop.
 */
async function waitResolvable(name, version, options) {
  const deadline = Date.now() + options.waitMs;
  let delay = 1000;
  for (let attempt = 1; ; attempt += 1) {
    if (probe(name, version, options, true) === 'published') return attempt;
    const left = deadline - Date.now();
    if (left <= 0) return 0;
    await sleep(Math.min(delay, left));
    delay = Math.min(delay * 2, 15_000);
  }
}

function localGate(workspace, root, options) {
  const failures = [];
  const dirty = capture('git', ['status', '--porcelain']).stdout.trim();
  const count = dirty === '' ? 0 : dirty.split('\n').length;
  if (count > 0 && options.real && !options.allowDirty) {
    failures.push(
      `the working tree carries ${count} uncommitted changes, so no tarball would match a commit; commit first, or pass --allow-dirty`,
    );
  } else if (count > 0) {
    console.log(`note: the working tree carries ${count} uncommitted changes.`);
  }
  for (const member of workspace.values()) {
    if (member.json.private === true) {
      failures.push(
        `${member.name}: private is true, so npm refuses to publish it`,
      );
    }
  }
  failures.push(
    ...crossPackageFindings(workspace, new Map([[root.name, root.version]])),
  );
  return failures;
}

function buildGate(workspace, options) {
  const failures = [];
  if (options.build && !inherit('node', ['scripts/build-packages.mjs'])) {
    failures.push(
      'scripts/build-packages.mjs failed; every package builds or none ships',
    );
  }
  if (
    !inherit('node', [
      '--test-timeout=600000',
      '--test',
      'test/packaging.test.ts',
    ])
  ) {
    failures.push('test/packaging.test.ts failed');
  }
  for (const member of workspace.values()) {
    if (member.json.scripts?.build && !existsSync(join(member.dir, 'dist'))) {
      failures.push(`${member.name}: builds, but has no dist/ afterwards`);
    }
  }
  return failures;
}

/** Names the packages depend on from outside packages/, which must already be resolvable. */
function outsideDependencies(workspace, root) {
  const wanted = new Set();
  for (const member of workspace.values()) {
    const deps = {
      ...member.json.dependencies,
      ...member.json.peerDependencies,
    };
    if (Object.hasOwn(deps, root.name)) wanted.add(root.name);
  }
  return [...wanted];
}

function registryGate(order, workspace, root, options) {
  const state = new Map();
  const failures = [];
  // Twelve packages in is a bad time to learn npm has no identity here. whoami answers with a
  // username; this script never reads, prints, or stores a token.
  if (options.real) {
    const who = capture('npm', [
      'whoami',
      '--fetch-retries=0',
      ...registryArgs(options),
    ]);
    if (who.status !== 0) {
      failures.push(
        `npm has no identity for this registry (${summarize(who.stderr)}); log in first`,
      );
    } else {
      console.log(`publishing as ${who.stdout.trim()}`);
    }
  }
  for (const name of order) {
    const { version } = workspace.get(name);
    const seen = probe(name, version, options);
    state.set(name, seen);
    if (seen === 'unknown') {
      failures.push(
        `${name}@${version}: the registry would not say whether this version exists`,
      );
    }
  }
  for (const name of outsideDependencies(workspace, root)) {
    if (probe(name, root.version, options) !== 'published') {
      failures.push(
        `${name}@${root.version} is depended on from packages/ but is not resolvable; publish it before this release`,
      );
    }
  }
  return { state, failures };
}

function refuse(phase, failures) {
  console.error(`\npublish-packages refuses to start — ${phase}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\nNothing was published.');
  return 1;
}

// The package's own prepublishOnly prints to this same stream first, so the report is the last
// JSON object on stdout rather than the whole of it.
function tailJson(stdout) {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i] !== '{') continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      return null;
    }
  }
  return null;
}

const SUSPECT = [
  [/(^|\/)node_modules\//, 'bundles node_modules'],
  [/\.test\.[cm]?[jt]sx?$/, 'ships a test file'],
  [/(^|\/)(__tests__|__mocks__)\//, 'ships a test directory'],
  [/^tests?\//, 'ships a test directory'],
  [/\.map$/, 'ships a source map'],
  [/\.tsbuildinfo$/, 'ships a TypeScript build cache'],
  [/(^|\/)\.env/, 'ships an env file'],
  [/(^|\/)\.npmrc$/, 'ships an npmrc'],
];

function tarballFindings(paths, member) {
  const findings = [];
  for (const [pattern, note] of SUSPECT) {
    const hits = paths.filter((path) => pattern.test(path));
    if (hits.length > 0)
      findings.push(
        `${note}: ${hits.slice(0, 4).join(', ')}${hits.length > 4 ? ` (+${hits.length - 4} more)` : ''}`,
      );
  }
  const claimsDist = (member.json.files ?? []).some(
    (entry) => entry.split('/')[0] === 'dist',
  );
  if (claimsDist && !paths.some((path) => path.startsWith('dist/'))) {
    findings.push('files claims dist, and the tarball has none');
  }
  return findings;
}

function byDirectory(paths) {
  const counts = new Map();
  for (const path of paths) {
    const key = path.includes('/')
      ? `${path.slice(0, path.indexOf('/'))}/`
      : '(top level)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => `${key} ${n}`).join(', ');
}

const kib = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KiB`;

const lastLines = (text, count) =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-count);

/** One package's `npm publish --dry-run`, reported as the tarball it would have uploaded. */
function reportDryRun(step, workspace, options) {
  const args = ['publish', '--dry-run', '--json', ...registryArgs(options)];
  if (options.ignoreScripts) args.push('--ignore-scripts');
  const { status, stdout, stderr } = capture('npm', args, step.dir);
  if (status !== 0) {
    console.error(`  npm publish --dry-run failed: ${summarize(stderr)}`);
    // The package's own prepublishOnly is what usually fails. Its reason is on stdout and npm's
    // exit code is on stderr, so both tails go out or the owner hunts for the real message.
    for (const line of [...lastLines(stdout, 8), ...lastLines(stderr, 6)]) {
      console.error(`  | ${line}`);
    }
    return false;
  }
  const report = tailJson(stdout)?.[step.name];
  if (report === undefined) {
    console.error('  npm publish --dry-run printed no report for this package');
    return false;
  }
  const paths = report.files.map((file) => file.path);
  console.log(
    `  ${report.entryCount} files, ${kib(report.size)} packed / ${kib(report.unpackedSize)} unpacked`,
  );
  console.log(`  ${byDirectory(paths)}`);
  if (options.files) for (const path of paths) console.log(`    ${path}`);
  // npm rewrites parts of a manifest as it packs and says so only in a warning. A dry run that
  // swallowed those would hide the difference between the manifest here and the published one.
  for (const line of stderr.split('\n')) {
    if (/^npm warn publish/.test(line)) console.log(`  ${line.trim()}`);
  }
  for (const finding of tarballFindings(paths, workspace.get(step.name))) {
    console.log(`  FINDING ${finding}`);
  }
  return true;
}

async function walk(plan, workspace, options) {
  let done = 0;
  let skipped = 0;
  for (const step of plan) {
    if (step.action === 'skip') {
      console.log(
        `skip    ${step.name}@${step.version} — already on the registry`,
      );
      skipped += 1;
      continue;
    }
    console.log(
      `${options.real ? 'publish' : 'dry-run'} ${step.name}@${step.version}`,
    );
    if (!options.real) {
      if (!reportDryRun(step, workspace, options))
        return { done, skipped, failed: step };
      done += 1;
      continue;
    }
    // npm publishes the manifest on disk, not the one preflight read. A version that moved
    // since then would go out unverified.
    const now = readWorkspace(ROOT).get(step.name);
    if (now?.version !== step.version) {
      console.error(
        `\n${step.name} is no longer at ${step.version} on disk. Re-run preflight.`,
      );
      return { done, skipped, failed: null };
    }
    // Inherited stdio, so npm's one-time-password prompt reaches the terminal. Capturing it
    // would hide the prompt and hang the release.
    if (
      !inherit(
        'npm',
        ['publish', '--tag', options.tag, ...registryArgs(options)],
        step.dir,
      )
    ) {
      return { done, skipped, failed: step };
    }
    done += 1;
    const attempts = await waitResolvable(step.name, step.version, options);
    if (attempts === 0) {
      console.error(
        `\n${step.name}@${step.version} published, but is still not resolvable after ${options.waitMs / 1000}s.`,
      );
      console.error(
        'Wait for the registry to catch up and re-run: published versions are skipped.',
      );
      return { done, skipped, failed: null };
    }
    console.log(
      `  resolvable after ${attempts} ${attempts === 1 ? 'check' : 'checks'}`,
    );
  }
  return { done, skipped, failed: undefined };
}

async function main(argv) {
  const { options, error } = parseOptions(argv);
  if (error !== undefined) {
    console.error(`publish-packages: ${error}\n\n${USAGE}`);
    return 1;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const workspace = readWorkspace(ROOT);
  const root = readRootPackage(ROOT);
  let order;
  try {
    order = dependencyOrder(workspace);
  } catch (cycle) {
    return refuse('the workspace graph does not sort', [cycle.message]);
  }

  console.log(
    `${workspace.size} packages, ${options.real ? 'PUBLISHING FOR REAL' : 'dry run'}, tag ${options.tag}${options.registry === '' ? '' : `, registry ${options.registry}`}`,
  );

  const local = localGate(workspace, root, options);
  if (local.length > 0)
    return refuse('the workspace is not release-shaped', local);
  const built = buildGate(workspace, options);
  if (built.length > 0) return refuse('the packages do not build clean', built);
  const { state, failures } = registryGate(order, workspace, root, options);
  if (failures.length > 0)
    return refuse('the registry state is not usable', failures);

  const plan = publishPlan(order, workspace, state);
  const blocked = plan.filter((step) => step.action === 'blocked');
  if (blocked.length > 0)
    return refuse(
      'the plan has holes',
      blocked.map((s) => s.reason),
    );

  console.log('\nplan:');
  for (const [i, step] of plan.entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${step.action.padEnd(7)} ${step.name}@${step.version}`,
    );
  }
  if (options.preflightOnly) {
    console.log('\nPreflight only. Nothing was published.');
    return 0;
  }

  const drift = planDrift(plan, readWorkspace(ROOT));
  if (drift.length > 0)
    return refuse('the workspace moved during preflight', drift);

  console.log('');
  const { done, skipped, failed } = await walk(plan, workspace, options);
  if (failed === undefined) {
    console.log(
      `\n${options.real ? 'published' : 'dry-ran'} ${done}, skipped ${skipped}${options.real ? '' : ' — nothing reached the registry. Add --publish-for-real to publish.'}`,
    );
    return 0;
  }
  if (failed !== null) {
    console.error(
      `\nStopped at ${failed.name}@${failed.version}. ${done} of ${plan.length} done.`,
    );
    console.error(
      'Fix it and re-run: everything already on the registry is skipped.',
    );
  }
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
