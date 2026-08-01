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

import { readFileSync } from 'node:fs';
import { COMMANDS, FLAGS, flagForm } from './parse-args.js';
import type { FlagSpec, VerbSpec } from './parse-args.js';

/** What argv asks for ahead of any verb, or null when it asks for none of it. */
export function helpRequest(
  argv: readonly string[],
): 'help' | 'version' | null {
  for (const a of argv) {
    if (a === '--help' || a === '-h') return 'help';
    if (a === '--version' || a === '-v') return 'version';
  }
  return null;
}

/** The name and version of this package, read from its own manifest. */
export function version(): string {
  const manifest = readFileSync(
    new URL('../../package.json', import.meta.url),
    'utf8',
  );
  const { name, version: v } = JSON.parse(manifest) as {
    name: string;
    version: string;
  };
  return `${name} ${v}`;
}

const pad = (items: readonly string[]): number =>
  Math.max(...items.map((s) => s.length));

/** Items across as many lines as they need, continuations under the first one. */
function wrap(head: string, items: readonly string[], width = 96): string {
  const indent = ' '.repeat(head.length);
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    const next = line ? `${line} ${item}` : item;
    if (line && head.length + next.length > width) {
      lines.push((lines.length ? indent : head) + line);
      line = item;
    } else line = next;
  }
  lines.push((lines.length ? indent : head) + line);
  return lines.join('\n');
}

function roster(): string {
  const width = pad(COMMANDS.map((c) => c.verb));
  return [
    'economy — run an economy module, and answer what it is',
    '',
    'usage: economy <verb> [flags]',
    '',
    ...COMMANDS.map((c) => `  ${c.verb.padEnd(width)}  ${c.describe}`),
    '',
    '  --help, -h       this roster; `economy <verb> --help` opens one verb',
    '  --version, -v    the version of this package',
    '',
    'no module file at all is a complete dev module: dev, worker, check, and routes run on',
    'defaults. serve still refuses to bind without an auth posture.',
  ].join('\n');
}

function page(spec: VerbSpec): string {
  const honored: FlagSpec[] = FLAGS.filter((f) => f.verbs.includes(spec.verb));
  const width = pad(honored.map(flagForm));
  return [
    `economy ${spec.verb} — ${spec.describe}`,
    '',
    wrap(
      `usage: economy ${spec.verb} `,
      honored.map((f) => `[${flagForm(f)}]`),
    ),
    '',
    'flags:',
    ...honored.map(
      (f) =>
        `  ${flagForm(f).padEnd(width)}  ${f.describe} (default: ${f.fallback})`,
    ),
    '',
    'example:',
    `  ${spec.example}   # ${spec.result}`,
  ].join('\n');
}

/** The named verb's page, or the roster when argv names no verb. */
export function renderHelp(verb: string | undefined): string {
  const spec = COMMANDS.find((c) => c.verb === verb);
  return spec ? page(spec) : roster();
}
