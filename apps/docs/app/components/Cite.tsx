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
 * A small "[n]" citation mark linking down to the page's `notes` entry `n` (1-based); the plain
 * paragraph cites via `plainCite`. Static markup.
 */
export function Cite({ n }: { n: number }) {
  return (
    <sup className="doc-cite">
      <a id={`cite-${n}-ref`} href={`#note-${n}`} aria-label={`Citation ${n}`}>
        [{n}]
      </a>
    </sup>
  );
}
