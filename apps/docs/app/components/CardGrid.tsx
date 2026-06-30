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

import { docBySlug } from '~/content.ts';

/** A grid of page cards (title + summary) for the section landing pages. Skips any slug that does not resolve, so a stale reference never renders an empty card. */
export function CardGrid({ slugs }: { slugs: string[] }) {
  return (
    <ul className="card-grid">
      {slugs.map((s) => {
        const d = docBySlug(s);
        if (!d) return null;
        return (
          <li className="doc-card" key={s}>
            <h3>
              <a href={`/${s}/`}>{d.title}</a>
            </h3>
            <p>{d.summary}</p>
          </li>
        );
      })}
    </ul>
  );
}
