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

export interface FailurePoints {
  /** Every `not ok` line with the YAML block under it, in transcript order. */
  readonly sections: readonly string[];
  /** How many of them node's `# fail` summary tallies. */
  readonly counted: number;
}

// A `# TODO` directive marks a point tallied under todo, not fail. A hash in a test's own
// name prints escaped as `\#`, so an unescaped hash is always the directive.
const TODO_DIRECTIVE = /(?<!\\)# todo\b/i;

/**
 * The failed points of a TAP transcript.
 *
 * Suites, todo tests and cancelled tests print `not ok` too. They stay in `sections` as
 * context, but `counted` follows `# fail`'s own tally: points typed `test`, minus todo
 * directives and minus `cancelledByParent`, which land under `# todo` and `# cancelled`.
 */
export function failureSections(output: string): FailurePoints {
  const lines = output.split('\n');
  const sections: string[] = [];
  let counted = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const point = /^(\s*)not ok \d+/.exec(lines[i]);
    if (point === null) continue;
    const indent = point[1];
    const block = [lines[i]];
    let test = false;
    let cancelled = false;
    if (lines[i + 1] === `${indent}  ---`) {
      for (i += 1; i < lines.length; i += 1) {
        block.push(lines[i]);
        if (lines[i] === `${indent}  type: 'test'`) test = true;
        if (lines[i] === `${indent}  failureType: 'cancelledByParent'`)
          cancelled = true;
        if (lines[i] === `${indent}  ...`) break;
      }
    }
    if (test && !cancelled && !TODO_DIRECTIVE.test(block[0])) counted += 1;
    sections.push(block.join('\n'));
  }
  return { sections, counted };
}

/**
 * What the fan-out prints for a suite whose run failed.
 *
 * TAP ends with the passing tail and the summary, so a byte window off the end of a long
 * failing suite shows everything but the failures. When the summary reports failed tests the
 * report is those points in the suite's own words; a transcript whose points cannot account
 * for the summary is printed whole rather than guessed at. With nothing failed — a crash, a
 * skip over budget, an empty run — the tail is all there is to show.
 */
export function failureReport(output: string, fail: number): string {
  const { sections, counted } = failureSections(output);
  if (fail === 0 && sections.length === 0) return output.slice(-4000);
  if (counted !== fail) {
    return [
      `  the transcript accounts for ${counted} of the ${fail} failures the summary reports; full output follows.`,
      output,
    ].join('\n');
  }
  return sections.join('\n');
}
