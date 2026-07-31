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

// A gate that proves a freshness refusal has to make the tree stale, and staleness is a property
// of the repository rather than of the file asserting it. Two such windows open at once make each
// other's control run refuse for the other's reason, and the root suite runs its files in
// parallel — so a window is taken one at a time.
//
// The control belongs inside the same hold: it runs after the mtime is put back and has to see a
// tree nobody else is holding stale.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const LOCK = '/tmp/economy-lab-stale-window';
const POLL_MS = 250;
// Well inside the file bound that cancels this file first, so a hold nobody released reads as
// this gate's own failure rather than as the runner giving up on the file.
const LIMIT_MS = 120_000;

/** Blocks this thread without a child process, which a sibling gate's window has to outlast. */
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Signal 0 tests for existence without delivering anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A hold whose owner has died is not a hold: a crashed gate must not wedge the next one. */
function taken(): boolean {
  try {
    // Atomic: the directory either did not exist and now belongs to this process, or it did.
    mkdirSync(LOCK);
    writeFileSync(`${LOCK}/pid`, `${process.pid}\n`);
    return true;
  } catch {
    let owner = 0;
    try {
      owner = Number(readFileSync(`${LOCK}/pid`, 'utf8').trim());
    } catch {
      // Written a moment after the directory, so an empty hold is one being taken right now.
      return false;
    }
    if (owner !== 0 && !alive(owner))
      rmSync(LOCK, { recursive: true, force: true });
    return false;
  }
}

/**
 * Runs the body with no other gate holding the tree in an artificial state. Waits rather than
 * failing, because the other holder is a sibling test file a few seconds from done.
 */
export function exclusively<T>(what: () => T): T {
  const start = Date.now();
  while (!taken()) {
    if (Date.now() - start > LIMIT_MS) {
      throw new Error(
        `stale-window: ${LOCK} was still held after ${Math.round(LIMIT_MS / 1000)}s`,
      );
    }
    pause(POLL_MS);
  }
  try {
    return what();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}
