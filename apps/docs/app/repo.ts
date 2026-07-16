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

// Where the source chips point. Pinned to a commit SHA, not a branch, so file contents and #Lnn
// anchors can't drift out from under the links. Bump REPO_REF when re-pointing the docs at a newer
// snapshot, then re-anchor the chips; app/anchors.test.ts fails while they disagree.
export const REPO_URL = 'https://github.com/pwngh/economy-lab';
export const REPO_REF = 'e7f9bedcd33167ea4efb3e12fe6c09110c368f8a';

/**
 * Turn a `sourceRefs` chip (`path · symbol`, the symbol descriptive only) into a GitHub blob URL at
 * the pinned ref. An optional `#Lnn` line anchor on the path carries straight through to the URL.
 * Returns null when the chip has no path, so the renderer can fall back to a plain (unlinked) label.
 */
export function sourceUrl(ref: string): string | null {
  const path = ref.split('·')[0]?.trim();
  if (!path) return null;
  return `${REPO_URL}/blob/${REPO_REF}/${path}`;
}
