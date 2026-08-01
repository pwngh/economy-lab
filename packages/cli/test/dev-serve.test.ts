/**
 * @pwngh/economy-cli
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
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { portInUseLine } from '../src/lib/commands/service.js';
import {
  PKG,
  TSX,
  childEnv,
  collect,
  runLive,
  runSync,
  stop,
  until,
} from './support/process.js';

// The plain-JavaScript spawn target and the built library it runs, for the watch test.
const BUILT_ENTRY = join(PKG, 'test/support/dist-entry.js');
const BUILT_LIB = join(PKG, 'dist/index.js');

// The same CLI under a stand-in for Bun, for the non-Node shutdown.
const BUN_ENTRY = join(PKG, 'test/support/bun-entry.ts');

// And under a stand-in for Deno, for the bind failure that runtime states its own way.
const DENO_ENTRY = join(PKG, 'test/support/deno-entry.ts');

test('serve refuses a platform-owned scaffold with the platform command and the routes pointer', () => {
  const cf = mkdtempSync(join(tmpdir(), 'economy-serve-cf-'));
  writeFileSync(
    join(cf, 'wrangler.jsonc'),
    '{ "name": "shop", "main": "worker.ts" }',
  );
  const refusedCf = runSync(['serve'], cf, { NODE_ENV: 'production' });
  assert.equal(refusedCf.status, 1);
  assert.match(refusedCf.stderr, /deploys as a Cloudflare Worker/);
  assert.match(refusedCf.stderr, /`wrangler dev` runs it/);
  assert.match(refusedCf.stderr, /economy routes/);

  const next = mkdtempSync(join(tmpdir(), 'economy-serve-next-'));
  writeFileSync(
    join(next, 'package.json'),
    JSON.stringify({ dependencies: { next: '^15.0.0' } }),
  );
  const refusedNext = runSync(['serve'], next);
  assert.equal(refusedNext.status, 1);
  assert.match(refusedNext.stderr, /deploys as a Next\.js app/);
  assert.match(refusedNext.stderr, /`next dev` runs it/);
});

test('port in use: one line naming the holder and the --port escape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-port-'));
  const holder = createServer();
  await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
  const port = (holder.address() as { port: number }).port;
  try {
    const r = runSync(['dev', '--port', String(port)], dir);
    assert.equal(r.status, 1);
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 1, `one clear line, got:\n${r.stderr}`);
    assert.match(
      lines[0]!,
      new RegExp(
        `^port ${port} is in use by .+ — stop it, or pick another: economy dev --port ${port + 1}$`,
      ),
    );
    assert.match(lines[0]!, /\(pid \d+\)|another process/);
  } finally {
    holder.close();
  }
});

test('port in use on a Fetch runtime: the same one line, not the runtime’s stack', async () => {
  // Deno raises `Deno.errors.AddrInUse`, which carries no `code` and no `port`. Before the bind
  // normalized it, this run printed a stack trace where the Node run above prints one line.
  const dir = mkdtempSync(join(tmpdir(), 'economy-port-deno-'));
  const r = spawnSync(
    process.execPath,
    ['--import', TSX, DENO_ENTRY, 'dev', '--port', '4711'],
    // Bounded like every other spawnSync here: it blocks the event loop, so a run that stopped
    // refusing and bound instead would wedge the suite rather than fail it.
    { cwd: dir, encoding: 'utf8', env: childEnv(), timeout: 30_000 },
  );
  assert.equal(r.status, 1);
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 1, `one clear line, got:\n${r.stderr}`);
  assert.match(
    lines[0]!,
    /^port 4711 is in use by .+ — stop it, or pick another: economy dev --port 4712$/,
  );
});

test('the taken-port line survives a probe that cannot run', () => {
  // The holder probe shells out, and Deno denies node:child_process without --allow-run. A throw
  // there would replace the refusal it serves with a stack — the defect this whole item is about,
  // one layer in.
  const thrown = portInUseLine({ port: 3000 }, 'dev', () => {
    throw new Error('Requires run access to "lsof"');
  });
  assert.equal(
    thrown,
    'port 3000 is in use by another process — stop it, or pick another: economy dev --port 3001',
  );
  // And a probe that answers still names the holder, so the line above is not what it always says.
  assert.match(
    portInUseLine({ port: 3000 }, 'serve', () => 'p4242\ncnode\n'),
    /^port 3000 is in use by node \(pid 4242\) — /,
  );
});

test('dev banner: posture + store + routes + the three curls, nothing else; SIGTERM exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-banner-'));
  const child = runLive(['dev', '--port', '0'], dir);
  const seen = collect(child);
  const out = await until(seen, /curl -X POST /);
  const lines = out.trim().split('\n');
  assert.equal(
    lines.length,
    7,
    `the banner is exactly seven lines, got:\n${out}`,
  );
  assert.match(
    lines[0]!,
    /^economy dev — \(defaults — no economy\.app\.ts\) on 127\.0\.0\.1:\d+, worker running$/,
  );
  assert.match(
    lines[1]!,
    /^ {2}posture {2}dev tokens \(module states no posture\)$/,
  );
  assert.match(lines[2]!, /^ {2}store {4}memory \(dev posture\)$/);
  assert.match(lines[3]!, /^ {2}routes {3}\d+$/);
  assert.match(lines[4]!, /^ {2}curl http:\/\/127\.0\.0\.1:\d+\/healthz$/);
  assert.match(
    lines[5]!,
    /^ {2}curl -H 'authorization: Bearer dev_user_ada' http:\/\/127\.0\.0\.1:\d+\/v1\/wallet$/,
  );
  assert.match(
    lines[6]!,
    /^ {2}curl -X POST http:\/\/127\.0\.0\.1:\d+\/submit -H 'authorization: Bearer dev_system_payments' /,
  );
  assert.equal(await stop(child), 0, 'SIGTERM drains and exits 0');
});

test('a Fetch runtime drains for SHUTDOWN_TIMEOUT_MS, then cuts, and the run exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-drain-'));
  const marks = join(dir, 'stub.log');
  writeFileSync(marks, '');
  const child = spawn(
    process.execPath,
    ['--import', TSX, BUN_ENTRY, 'dev', '--port', '0'],
    {
      cwd: dir,
      detached: true,
      env: childEnv({ ECONOMY_STUB_LOG: marks, SHUTDOWN_TIMEOUT_MS: '600' }),
    },
  );
  const seen = collect(child);
  await until(seen, /^economy dev — /m);
  // The graceful stop this stub answers never settles, so an exit at all means the cut landed.
  assert.equal(await stop(child), 0, 'the run never reached the cut');
  const log = readFileSync(marks, 'utf8');
  const at = new Map(
    log
      .trim()
      .split('\n')
      .map((line) => line.split(' '))
      .map(([name, when]) => [name, Number(when)] as const),
  );
  assert.deepEqual(
    [...at.keys()],
    ['drain', 'cut'],
    `drain then cut, got:\n${log}`,
  );
  const waited = at.get('cut')! - at.get('drain')!;
  assert.ok(
    waited >= 400,
    `the cut came ${waited} ms after the drain, so the 600 ms budget never reached the leg`,
  );
  assert.ok(
    waited < 3_000,
    `the cut came ${waited} ms after the drain, against a 600 ms budget`,
  );
});

test('boot failure prints the module error then the one-line check hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-hint-'));
  writeFileSync(join(dir, 'bad.app.ts'), 'export const frobnicate = 1;\n');
  const r = runSync(['dev', '--app', 'bad.app.ts'], dir);
  assert.equal(r.status, 1);
  const lines = r.stderr.trim().split('\n');
  assert.match(lines[0]!, /ECONOMY_MODULE\.UNKNOWN_EXPORT/);
  assert.equal(
    lines[lines.length - 1],
    'run `economy check` for the full picture',
  );
});

test('dev --watch: state loss stated, the runtime watcher restarts, --demo reseeds each boot', async () => {
  // The one spawn here carries no tsx: under tsx's loader the restart never reseeds, because
  // only node's own loader puts a .ts module into the watch graph.
  assert.ok(
    existsSync(BUILT_LIB),
    `${BUILT_LIB} is missing — run npm run build`,
  );
  const dir = mkdtempSync(join(tmpdir(), 'economy-watch-'));
  const file = join(dir, 'economy.app.ts');
  writeFileSync(file, 'export const authenticate = false;\n');
  const child = spawn(
    process.execPath,
    [BUILT_ENTRY, 'dev', '--watch', '--demo', '--port', '0'],
    {
      cwd: dir,
      detached: true,
      env: childEnv(),
    },
  );
  const seen = collect(child);
  try {
    await until(
      seen,
      /--watch: the node watcher restarts the whole process on change — in-memory state is lost each time; --demo reseeds every boot/,
    );
    await until(seen, /demo seeded/);
    appendFileSync(file, 'export const worker = { intervalMs: 4000 };\n');
    // A second seed line proves the restart rebuilt the store and reseeded it.
    await until(seen, /demo seeded[\s\S]*demo seeded/);
  } finally {
    await stop(child);
  }
});

// Both --experimental-strip-types sites are re-execs, and neither is reachable from a test that
// runs in this process, so what the flag does is proved against node itself.
test('the strip-types flag is the recovery for stripping turned off, not for plain node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-strip-'));
  writeFileSync(join(dir, 'mod.ts'), 'export const stripped: number = 1;\n');
  writeFileSync(
    join(dir, 'entry.mjs'),
    'await import(new URL("./mod.ts", import.meta.url).href);\n',
  );
  // Bounded like every other spawnSync here: it blocks the event loop, so a node that stopped
  // exiting would wedge the suite rather than fail it. Each run imports one module and returns.
  const at = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [...args, join(dir, 'entry.mjs')], {
      encoding: 'utf8',
      env: childEnv({ NODE_OPTIONS: '', ...env }),
      timeout: 30_000,
    });

  // Plain node reads the TypeScript module, so the catch the first flag sits behind never fires.
  assert.equal(at([]).status, 0, at([]).stderr);
  // Turning stripping off is the one way back to the error that catch reads.
  const off = at([], { NODE_OPTIONS: '--no-experimental-strip-types' });
  assert.equal(off.status, 1);
  assert.match(off.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
  // And the flag on the command line beats it, which is the whole reason the re-exec passes one.
  const back = at(['--experimental-strip-types'], {
    NODE_OPTIONS: '--no-experimental-strip-types',
  });
  assert.equal(back.status, 0, back.stderr);

  // The floor is the release that turned stripping on, so no supported runtime needs the flag
  // for its own sake. The comments say that rather than implying the flag carries the import.
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
    engines: { node: string };
  };
  assert.equal(pkg.engines.node, '>=22.18');
  const src = readFileSync(join(PKG, 'src/lib/commands/service.ts'), 'utf8');
  assert.equal((src.match(/'--experimental-strip-types'/g) ?? []).length, 2);
  assert.equal(
    src.includes('Plain node cannot parse a TypeScript module file'),
    false,
  );
  assert.equal(src.includes('node ≥23.6'), false);
  assert.ok(
    src.includes('--no-experimental-strip-types'),
    'the comment names what turns it off',
  );
  assert.ok(
    src.includes('NODE_OPTIONS'),
    'and where the watched process meets the same switch',
  );
});

/**
 * One request on an unpooled socket, so nothing outlives the assertion. The peer is a process this
 * suite spawned, and one that accepts the connection and then says nothing would leave the request
 * waiting with no ceiling of its own.
 */
function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, agent: false, timeout: 20_000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`GET ${path} was never answered`));
    });
    req.on('error', reject);
    req.end();
  });
}

// A .env re-execs dev under `node --env-file`, so the run under test is a grandchild. The
// exit code below is what proves the first process still owns the second.
test('dev loads .env through node --env-file: the named PORT is the bound port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-envfile-'));
  const port = 21000 + Math.floor(Math.random() * 20000);
  writeFileSync(join(dir, '.env'), `PORT=${port}\n`);
  const child = runLive(['dev'], dir);
  const seen = collect(child);
  let code: number | null = null;
  try {
    const out = await until(seen, /economy dev — /);
    assert.match(out, /\.env loaded via node --env-file/);
    await until(seen, new RegExp(`on 127\\.0\\.0\\.1:${port}, worker running`));
    assert.equal(
      await get(port, '/healthz'),
      200,
      `the port named in .env is the one serving`,
    );
    code = await stop(child);
  } finally {
    if (code === null)
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
  }
  assert.equal(
    code,
    0,
    'SIGTERM drains the re-exec and the run answers with its code',
  );
});
