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

import { useLocation } from 'react-router';

import { buildNav } from '~/nav.ts';

/**
 * The full page tree grouped by section, static markup; active state derives from the current path
 * and bakes into each prerendered page.
 */
export function Sidebar() {
  const { pathname } = useLocation();
  const isActive = (slug: string) => pathname === `/${slug}/` || pathname === `/${slug}`;

  return (
    <nav className="docs-sidebar" aria-label="Documentation">
      {buildNav().map((g) => (
        <div className="nav-group" key={g.title}>
          <a className="nav-group-title" href={g.href}>
            {g.title}
          </a>
          {g.items.length > 0 && (
            <ul>
              {g.items.map((l) => (
                <li key={l.slug}>
                  <a href={`/${l.slug}/`} aria-current={isActive(l.slug) ? 'page' : undefined}>
                    {l.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {g.subgroups?.map((sg) => (
            <div className="nav-subgroup" key={sg.title}>
              <a className="nav-subgroup-title" href={sg.href}>
                {sg.title}
              </a>
              <ul>
                {sg.items.map((l) => (
                  <li key={l.slug}>
                    <a href={`/${l.slug}/`} aria-current={isActive(l.slug) ? 'page' : undefined}>
                      {l.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}
