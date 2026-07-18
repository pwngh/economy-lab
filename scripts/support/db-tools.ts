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

// Shared plumbing for the backup/restore tooling: spawn a database client tool with piped
// files, and name/locate dump files. Connection details travel as argument arrays and env
// vars, never through a shell.

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const BACKUP_DIR = 'backups';

/** Filesystem-safe UTC stamp for dump filenames, second precision. */
export function dumpStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Runs a client tool to completion, optionally piping a file in and/or out. A missing binary
 * reports itself by name instead of a bare ENOENT; a nonzero exit rejects (stderr is inherited,
 * so the tool's own message is already on screen).
 */
export function runTool(
  command: string,
  args: ReadonlyArray<string>,
  io: {
    stdinFrom?: string;
    stdoutTo?: string;
    env?: Record<string, string>;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...io.env },
      stdio: [
        io.stdinFrom === undefined ? 'ignore' : 'pipe',
        io.stdoutTo === undefined ? 'ignore' : 'pipe',
        'inherit',
      ],
    });
    if (io.stdinFrom !== undefined) {
      createReadStream(io.stdinFrom).pipe(child.stdin!);
    }
    if (io.stdoutTo !== undefined) {
      child.stdout!.pipe(createWriteStream(io.stdoutTo));
    }
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(`${command} not found on PATH`)
          : error,
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

/** The mysql/mysqldump connection arguments for a mysql:// URL; the password rides MYSQL_PWD. */
export function mysqlClientArgs(url: string): {
  args: string[];
  database: string;
  env: Record<string, string>;
} {
  const parsed = new URL(url);
  return {
    args: [
      `--host=${parsed.hostname}`,
      `--port=${parsed.port || '3306'}`,
      `--user=${decodeURIComponent(parsed.username)}`,
      '--default-character-set=utf8mb4',
    ],
    database: parsed.pathname.replace(/^\//, ''),
    env: { MYSQL_PWD: decodeURIComponent(parsed.password) },
  };
}

/** Newest dump file for an engine prefix (`pg` / `mysql`), or null when none exist. */
export async function newestDump(prefix: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(BACKUP_DIR);
  } catch {
    return null;
  }
  const dumps = names
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.sql'))
    .sort();
  const newest = dumps.at(-1);
  return newest === undefined ? null : join(BACKUP_DIR, newest);
}
