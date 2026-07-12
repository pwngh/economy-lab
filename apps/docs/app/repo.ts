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
export const REPO_REF = '2b8f1b8084b5f0f188d7b9a0ac4955e84409b336';

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
