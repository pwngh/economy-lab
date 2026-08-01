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

import { compileEconomy, compilePostures } from '@pwngh/economy-core/module';
import { explainFromTruth, renderExplain, toJson } from '../render.js';
import { adoptEnvFile, load as loadModule } from './service.js';
import type { Sink } from '../cli.js';
import type { Args } from '../parse-args.js';

/**
 * Reports every posture the run can take: the deployed reading, which is what `serve` and
 * `worker` boot, and the verdict `dev` reaches, which is a decorated definition. Both are judged
 * on the environment `.env` puts in place, because that is the one the next command will have.
 *
 * Exit 2 covers all of them. A clean `check` in front of a `dev` that refuses is the one failure
 * this verb cannot have.
 */
export async function runCheckCommand(args: Args, out: Sink): Promise<number> {
  // Before the load, not after: the module reads the environment while it is being imported.
  const restoreEnv = adoptEnvFile();
  try {
    const mod = await loadModule(args, 0);
    const truth = compileEconomy(mod, process.env, args.flags);
    const postures = compilePostures(mod, process.env);
    const errors = postures.flatMap((p) =>
      p.preflight.filter(
        (i) => (i as { severity?: string }).severity === 'error',
      ),
    );

    const report = explainFromTruth(truth, postures, restoreEnv !== null);
    // --desugar beside --json rides in the report, so neither flag is silently dropped.
    if (args.json)
      out.write(
        `${toJson(args.desugar ? { ...report, desugar: truth.desugar } : report)}\n`,
      );
    else if (args.desugar) out.write(`${truth.desugar}\n`);
    else {
      out.write(`${renderExplain(report)}\n`);
      if (!errors.length && !truth.lints.length)
        out.write(`${truth.module.file}: clean\n`);
    }
    return errors.length ? 2 : truth.lints.length && !args.quietLints ? 1 : 0;
  } finally {
    restoreEnv?.();
  }
}
