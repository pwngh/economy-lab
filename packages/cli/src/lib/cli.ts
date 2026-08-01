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

import { EconomyModuleError } from '@pwngh/economy-core/module';
import { helpRequest, renderHelp, version } from './help.js';
import { parse } from './parse-args.js';

/** Where a verb writes: the process streams, or whatever a host hands it. */
export interface Sink {
  write(text: string): unknown;
}

/** A re-exec already ran the whole invocation; this carries its code back up. */
export class ReExecuted extends Error {
  constructor(readonly status: number) {
    super(`the re-exec answered ${status}`);
    this.name = 'ReExecuted';
  }
}

export interface RunEconomyOptions {
  /** Where banners, reports, and refusals go; defaults to the process streams. */
  readonly stdout?: Sink;
  readonly stderr?: Sink;
}

// `dev`, `serve`, and `worker` hold the process open on purpose; the rest answer and leave.
const SERVICE_VERBS = ['dev', 'serve', 'worker'];

/**
 * Runs one `economy` invocation and resolves its exit code. Never calls `process.exit`, so
 * a host can drive the CLI in-process — the bin is the only place that exits.
 */
// complexity 17: the verb dispatch and the error classification under it.
// eslint-disable-next-line complexity
export async function runEconomy(
  argv: string[],
  options: RunEconomyOptions = {},
): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  // Help and version are answers, not refusals: stdout, exit 0, before anything loads.
  const asked = helpRequest(argv);
  if (asked !== null) {
    out.write(`${asked === 'version' ? version() : renderHelp(argv[0])}\n`);
    return 0;
  }
  const parsed = parse(argv);
  if (!parsed.ok) {
    err.write(`${parsed.refusal}\n`);
    return 2;
  }
  const { args } = parsed;
  try {
    if (args.cmd === 'check') {
      const { runCheckCommand } = await import('./commands/check.js');
      return await runCheckCommand(args, out);
    }
    if (args.cmd === 'routes') {
      const { runRoutesCommand } = await import('./commands/routes.js');
      return await runRoutesCommand(args, out);
    }
    const { runService } = await import('./commands/service.js');
    return await runService(args, out, err);
  } catch (e) {
    // A re-exec ran the invocation to completion; its code is this run's answer.
    if (e instanceof ReExecuted) return e.status;
    // The stack, never the raw object: driver errors carry enumerable extras (ERR_INVALID_URL
    // keeps the whole connection string, credentials included).
    // The brand, not `instanceof`: a duplicated core install would drop a named refusal to the
    // bare-stack branch, losing the file, the export, and the fix.
    err.write(
      `${
        EconomyModuleError.is(e)
          ? e.message
          : e instanceof Error
            ? (e.stack ?? e.message)
            : String(e)
      }\n`,
    );
    if (SERVICE_VERBS.includes(args.cmd) && EconomyModuleError.is(e)) {
      err.write('run `economy check` for the full picture\n');
    }
    return args.cmd === 'check' ? 2 : 1;
  }
}
