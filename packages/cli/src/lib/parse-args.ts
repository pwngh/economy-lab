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

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { knobRule, readKnobOrNull } from '@pwngh/economy-core/module';
import type { KnobKey } from '@pwngh/economy-core';

export const CANDIDATES = [
  'economy.app.ts',
  'economy.app.mts',
  'economy.app.mjs',
  'economy.app.js',
];

export interface Args {
  cmd: string;
  file: string;
  explicit: boolean;
  demo: boolean;
  watch: boolean;
  worker: boolean;
  json: boolean;
  desugar: boolean;
  quietLints: boolean;
  host: string | undefined;
  flags: Partial<Record<KnobKey, number>>;
}

/** One verb, as the roster lists it and as its own help page opens. */
export interface VerbSpec {
  readonly verb: string;
  readonly describe: string;
  /** The worked example help prints, and what running it does. */
  readonly example: string;
  readonly result: string;
}

/** The framework roster: run the app, and answer what it is. Operating a live economy is
 *  the lab's job (`npm run db:migrate`, `backup`, `restore:drill`), not the front door's. */
export const COMMANDS: readonly VerbSpec[] = [
  {
    verb: 'dev',
    describe:
      'run the module locally: memory store, dev tokens, reload on change',
    example: 'economy dev --demo --port 4000',
    result: 'seeded, on 127.0.0.1:4000',
  },
  {
    verb: 'serve',
    describe:
      'run the module in production; every dev stand-in refuses before the bind',
    example: 'NODE_ENV=production economy serve --port 8080',
    result: 'binds every interface',
  },
  {
    verb: 'worker',
    describe: 'run the worker role alone — background sweeps, no socket',
    example: 'economy worker --interval 5000',
    result: 'sweeps every 5 seconds',
  },
  {
    verb: 'check',
    describe:
      'compile the module and the environment, and print what they resolve to',
    example: 'economy check --json',
    result: 'the same report, canonical, for CI',
  },
  {
    verb: 'routes',
    describe: 'print the auth posture and the table the module mounts',
    example: 'economy routes --json',
    result: 'each route tagged module or product',
  },
];

export const VERBS = COMMANDS.map((c) => c.verb);

/** One flag, as `parse` accepts it and as help prints it — one table, so the two cannot drift. */
export interface FlagSpec {
  readonly flag: string;
  /** The value's placeholder in usage, or null when the flag is a switch. */
  readonly takes: string | null;
  /** The verbs whose behavior this flag changes. */
  readonly verbs: readonly string[];
  readonly describe: string;
  /** What holds without the flag. */
  readonly fallback: string;
  /** Folds the typed value into the args; false rejects the value. */
  readonly fold: (args: Args, value: string) => boolean;
}

// The lab's integer rule, not a second one: `Number` here read `--port 0x1f` as 31 and
// `--port 8080.5` as a fractional port that only failed inside node's socket layer. A value
// typed at a prompt is refused rather than clamped — the person who typed it is present.
const knob =
  (key: KnobKey) =>
  (args: Args, value: string): boolean => {
    const n = readKnobOrNull(key, value);
    if (n === null) return false;
    args.flags[key] = n;
    return true;
  };

/** Which knob a numeric flag carries, so a refusal can quote that knob's own rule. */
const KNOB_OF: Record<string, KnobKey> = {
  '--port': 'PORT',
  '--interval': 'WORKER_INTERVAL_MS',
  '--batch': 'WORKER_BATCH',
};

const set =
  (fold: (args: Args) => void) =>
  (args: Args): boolean => {
    fold(args);
    return true;
  };

export const FLAGS: readonly FlagSpec[] = [
  {
    flag: '--app',
    takes: 'file',
    verbs: VERBS,
    describe: 'the module to run',
    fallback: 'economy.app.* or economy/ beside you',
    fold: (args, value) => {
      args.file = value;
      args.explicit = true;
      return true;
    },
  },
  {
    flag: '--demo',
    takes: null,
    verbs: ['dev', 'worker'],
    describe: 'seed a top-up, a spend, and a rejection at boot',
    fallback: 'no seed',
    fold: set((args) => {
      args.demo = true;
    }),
  },
  {
    flag: '--watch',
    takes: null,
    verbs: ['dev'],
    describe: "restart through the runtime's own watcher",
    fallback: 'the module file, in place',
    fold: set((args) => {
      args.watch = true;
    }),
  },
  {
    flag: '--no-worker',
    takes: null,
    verbs: ['dev', 'serve'],
    describe: 'bind the socket without the background half',
    fallback: 'the worker runs too',
    fold: set((args) => {
      args.worker = false;
    }),
  },
  {
    flag: '--json',
    takes: null,
    verbs: ['check', 'routes'],
    describe: 'print the report canonical, for tooling',
    fallback: 'the human table',
    fold: set((args) => {
      args.json = true;
    }),
  },
  {
    flag: '--desugar',
    takes: null,
    verbs: ['check'],
    describe: 'print the floor calls the module compiles to',
    fallback: 'the human table',
    fold: set((args) => {
      args.desugar = true;
    }),
  },
  {
    flag: '--quiet-lints',
    takes: null,
    verbs: ['check'],
    describe: 'stop a lint from setting exit 1',
    fallback: 'a lint exits 1',
    fold: set((args) => {
      args.quietLints = true;
    }),
  },
  {
    flag: '--host',
    takes: 'h',
    verbs: ['dev', 'serve'],
    describe: 'the interface to bind',
    fallback: '127.0.0.1 on dev, every interface on serve',
    fold: (args, value) => {
      args.host = value;
      return true;
    },
  },
  {
    flag: '--port',
    takes: 'n',
    verbs: ['dev', 'serve'],
    describe: 'the port to bind',
    fallback: '3000',
    fold: knob('PORT'),
  },
  {
    flag: '--interval',
    takes: 'ms',
    verbs: ['dev', 'serve', 'worker'],
    describe: 'how often the worker sweeps',
    fallback: '60000',
    fold: knob('WORKER_INTERVAL_MS'),
  },
  {
    flag: '--batch',
    takes: 'n',
    verbs: ['dev', 'serve', 'worker'],
    describe: 'how many jobs one sweep takes',
    fallback: '100',
    fold: knob('WORKER_BATCH'),
  },
];

/** The flag as it is typed, value placeholder included. */
export const flagForm = (f: FlagSpec): string =>
  f.takes ? `${f.flag} ${f.takes}` : f.flag;

const listVerbs = (verbs: readonly string[]): string =>
  verbs.length === 1
    ? verbs[0]!
    : `${verbs.slice(0, -1).join(', ')} and ${verbs.at(-1)}`;

/** A flag the parser knows, aimed at a verb that does not act on it. */
const outOfScope = (f: FlagSpec, cmd: string): string =>
  `economy ${cmd} does not take ${f.flag} — it is a ${listVerbs(f.verbs)} flag;` +
  ` \`economy ${cmd} --help\` lists what ${cmd} takes`;

export const USAGE = [
  `usage: economy <${VERBS.join('|')}> [flags]`,
  `  switches: ${FLAGS.filter((f) => f.takes === null)
    .map((f) => f.flag)
    .join(' ')}`,
  `  values:   ${FLAGS.filter((f) => f.takes !== null)
    .map(flagForm)
    .join(' ')}`,
  '  help:     economy --help · economy <verb> --help · economy --version',
].join('\n');

/** A value the flag's own knob will not take. Names the rule rather than dumping usage alone:
 *  the fault is one value, and `--port 0x1f` looks like a number until something says what one
 *  is. */
const badValue = (f: FlagSpec, value: string): string => {
  const key = KNOB_OF[f.flag];
  return key === undefined
    ? USAGE
    : `${f.flag} takes ${knobRule(key)} — \`${value}\` is not one\n${USAGE}`;
};

/** One flag, two values. Taking the last would resolve the conflict for the person who typed
 *  it, which is the same silent drop an out-of-scope flag refuses. */
const duplicate = (f: FlagSpec, first: string, second: string): string =>
  `${f.flag} is given twice — \`${first}\` then \`${second}\`; drop one`;

/** A refusal carries the line to print; the caller answers 2 either way. */
export type Parsed =
  | { readonly ok: true; readonly args: Args }
  | { readonly ok: false; readonly refusal: string };

const refuse = (refusal: string): Parsed => ({ ok: false, refusal });

/**
 * Refuses with usage on a missing or unknown verb, an unknown flag, a flag missing its value,
 * or a non-numeric value on a numeric flag; a flag the verb does not act on refuses by name,
 * and a value flag given twice refuses naming both values.
 */
export function parse(argv: string[]): Parsed {
  // No implicit verb: a missing verb is the most ambiguous input, so it refuses the way an
  // unknown one does instead of starting a service.
  const [cmd, ...rest] = argv;
  if (cmd === undefined || !VERBS.includes(cmd)) return refuse(USAGE);
  const args: Args = {
    cmd,
    file: '',
    explicit: false,
    demo: false,
    watch: false,
    worker: true,
    json: false,
    desugar: false,
    quietLints: false,
    host: undefined,
    flags: {},
  };
  // Each value flag's first value, so a repeat can quote what it is contradicting.
  const given = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const spec = FLAGS.find((f) => f.flag === rest[i]);
    if (!spec) return refuse(USAGE);
    // A flag the verb does not act on is a mistake, not a no-op: parsing it clean and
    // dropping it hands back exit 0 with nothing done.
    if (!spec.verbs.includes(cmd)) return refuse(outOfScope(spec, cmd));
    let value = '';
    if (spec.takes !== null) {
      const raw = rest[(i += 1)];
      if (raw === undefined || raw.startsWith('--')) return refuse(USAGE);
      value = raw;
      const first = given.get(spec.flag);
      if (first !== undefined) return refuse(duplicate(spec, first, value));
      given.set(spec.flag, value);
    }
    if (!spec.fold(args, value)) return refuse(badValue(spec, value));
  }
  // Default resolution: the single-file candidates first, then the economy/ directory form.
  if (!args.file) {
    args.file =
      CANDIDATES.find((c) => existsSync(resolve(c))) ??
      (CANDIDATES.some((c) =>
        existsSync(resolve('economy', c.replace('economy.', ''))),
      )
        ? 'economy'
        : CANDIDATES[0]!);
  }
  return { ok: true, args };
}
