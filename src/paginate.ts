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
 * One bounded page of an async stream: the rows in [offset, offset + limit), plus the full
 * total. Drains the source — the total requires it — and offset rows shift under live writes,
 * so this is for quiescent or snapshot-ish reads: consoles, ops scripts, tests. A live feed
 * should iterate the stream and stop instead.
 */
export async function paginate<T>(
  source: AsyncIterable<T>,
  page: { offset: number; limit: number },
): Promise<{ rows: T[]; total: number }> {
  // The env module's integer spirit: malformed bounds clamp to whole non-negatives rather than
  // silently selecting a surprising window.
  const offset = Math.max(0, Math.floor(page.offset) || 0);
  const limit = Math.max(0, Math.floor(page.limit) || 0);
  const rows: T[] = [];
  let total = 0;
  for await (const item of source) {
    if (total >= offset && rows.length < limit) {
      rows.push(item);
    }
    total += 1;
  }
  return { rows, total };
}
