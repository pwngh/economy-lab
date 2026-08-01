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

import { compileEconomy } from '@pwngh/economy-core/module';
import { renderRoutes, toJson } from '../render.js';
import { adoptEnvFile, load as loadModule } from './service.js';
import type { Sink } from '../cli.js';
import type { Args } from '../parse-args.js';

export async function runRoutesCommand(args: Args, out: Sink): Promise<number> {
  // The same environment the run will have, in place before the load: a module file decides its
  // seams while it is being imported, so a table read under a different one is another module's.
  const restoreEnv = adoptEnvFile();
  try {
    const mod = await loadModule(args, 0);
    const truth = compileEconomy(mod, process.env, args.flags);
    out.write(
      `${
        args.json
          ? toJson({ posture: truth.posture, routes: truth.routes })
          : renderRoutes(truth.capabilities, truth.posture)
      }\n`,
    );
    return 0;
  } finally {
    restoreEnv?.();
  }
}
