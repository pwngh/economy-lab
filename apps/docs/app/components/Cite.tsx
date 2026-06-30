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
 * A very small "[n]" citation mark, trailing a claim that rests on outside authority rather than on
 * what economy-lab proves. `n` is the 1-based position of the matching entry in the page's `notes`
 * frontmatter; the mark links down to that note, which {@link DocPage} renders in the "Notes" section
 * at the foot of the page. Used in body MDX as `<Cite n={1} />`; the plain paragraph cites via the
 * `plainCite` frontmatter field, which renders this same mark. Static markup, no JavaScript.
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
