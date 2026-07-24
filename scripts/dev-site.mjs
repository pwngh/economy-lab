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

// One-origin dev for the composed site: builds the docs' snippet runner once (so /runner/loader.js
// exists) and generates the API reference once (docs/, so /api/ serves), then runs both dev
// servers — docs on :4173 with /console proxied to the console app on :4174 and /api proxied to a
// static server over the generated reference on :4175. One Ctrl-C stops everything.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

function run(name, args) {
  const child = spawn('npm', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // npm is npm.cmd on Windows, which only a shell can spawn.
    shell: process.platform === 'win32',
  });
  const tag = (chunk) =>
    chunk
      .toString()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => `[${name}] ${line}\n`)
      .join('');
  child.stdout.on('data', (d) => process.stdout.write(tag(d)));
  child.stderr.on('data', (d) => process.stderr.write(tag(d)));
  return child;
}

function step(name, args, what) {
  return new Promise((resolve, reject) => {
    const child = run(name, args);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${what} failed (${code})`)),
    );
  });
}

await step(
  'runner',
  ['run', 'build:runner', '--prefix', 'apps/docs'],
  'runner build',
);
await step('api', ['run', 'docs:api'], 'api reference generation');

// The generated reference behind the docs dev server's /api proxy: static files only, resolved
// inside docs/ with the /api prefix stripped.
const API_DIR = 'docs';
const API_PORT = 4175;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};
const apiServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = decodeURIComponent(url.pathname).replace(/^\/api(?=\/|$)/, '');
  if (path === '') {
    // The pages use relative asset URLs, which resolve against the directory — so the slashless
    // form must redirect, exactly as Pages serves a directory index in production.
    res.writeHead(308, { location: `/api/${url.search}` }).end();
    return;
  }
  if (path.endsWith('/')) {
    path += 'index.html';
  }
  const file = normalize(join(API_DIR, path));
  if (
    !file.startsWith(API_DIR) ||
    !existsSync(file) ||
    statSync(file).isDirectory()
  ) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(res);
});
apiServer.listen(API_PORT);

const servers = [
  run('docs', ['run', 'dev', '--prefix', 'apps/docs']),
  run('console', ['run', 'dev', '--prefix', 'apps/console']),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.kill('SIGINT');
  apiServer.close();
  // With the children killed and the api server closed the event loop drains and the process
  // ends on its own.
  process.exitCode = code;
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const server of servers) {
  server.on('exit', (code) => stop(code ?? 1));
}

console.log(
  'site dev: http://localhost:4173 — docs at /, console proxied at /console/, api reference at /api/',
);
