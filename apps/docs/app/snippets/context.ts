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

/**
 * What a run reports back: the lines the page prints, plus where the console handoff link lands —
 * a posting to drill into, or a console page path like '/integrity'. The snippets themselves take
 * the real `Economy` and import only what the published package exports; check-samples compiles
 * them whole against the entry points, so nothing shown here can lean on an internal.
 */
export interface SnippetReport {
  lines: string[];
  txnId?: string;
  consolePath?: string;
}
