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

// Where the source chips point. Pinned to a commit SHA, not a branch, so a chip's file contents and
// any #Lnn line anchor can't drift out from under the link when the source changes later — the same
// "pin the version so the reference can't rot" instinct as the docs base URL. Bump REPO_REF when you
// re-point the docs at a newer snapshot of economy-lab, then re-anchor the chips; app/anchors.test.ts
// fails whenever the anchors and the library tree disagree.
export const REPO_URL = 'https://github.com/pwngh/economy-lab';
export const REPO_REF = '38b17841742c2a4f8289e845337ab52dca4740c4';

/**
 * Turn a `sourceRefs` chip into a GitHub blob URL at the pinned ref. A chip is `path · symbol` (the
 * symbol is descriptive only). An optional `#Lnn` line anchor may be appended to the path
 * (`src/foo.ts#L42 · bar`) and is carried straight through to the URL. Returns null when the chip has
 * no file path, so the renderer can fall back to a plain (unlinked) label.
 */
export function sourceUrl(ref: string): string | null {
  const path = ref.split('·')[0]?.trim();
  if (!path) return null;
  return `${REPO_URL}/blob/${REPO_REF}/${path}`;
}
