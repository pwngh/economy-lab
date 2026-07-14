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
// exists), then runs both dev servers — docs on :4173 with /console proxied to the console app on
// :4174. One Ctrl-C stops both.
import { spawn } from 'node:child_process';

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

await new Promise((resolve, reject) => {
  const build = run('runner', ['run', 'build:runner', '--prefix', 'apps/docs']);
  build.on('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`runner build failed (${code})`)),
  );
});

const servers = [
  run('docs', ['run', 'dev', '--prefix', 'apps/docs']),
  run('console', ['run', 'dev', '--prefix', 'apps/console']),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.kill('SIGINT');
  // With both children killed the event loop drains and the process ends on its own.
  process.exitCode = code;
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
for (const server of servers) {
  server.on('exit', (code) => stop(code ?? 1));
}

console.log(
  'site dev: http://localhost:4173 — docs at /, console proxied at /console/',
);
