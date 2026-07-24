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

import type { ReactNode } from 'react';

/**
 * An inline prose link to a symbol's page on the generated /api reference, used in MDX as
 * `<ApiLink to="variables/src.spend" />` or `<ApiLink to="interfaces/src.Economy#submit" />`.
 * The `to` value is the TypeDoc output path (kind directory plus module-qualified page name,
 * no extension); a `#member` suffix lands on that member's anchor. Pass `children` to override
 * the visible label when the symbol is already named in the sentence.
 *
 * Same-tab navigation on purpose: /api is part of this site, unlike SourceLink's GitHub hrefs.
 * app/api-links.test.ts holds every `to` to a page in the generated output, so a rename breaks
 * the build rather than the reader.
 */
export function ApiLink({ to, children }: { to: string; children?: ReactNode }) {
  const [page = '', member] = to.split('#');
  const symbol = page.split('.').pop() ?? page;
  const label = children ?? (member ? `${symbol}.${member}` : symbol);
  const href = `/api/${page}.html${member ? `#${member}` : ''}`;
  return (
    <a href={href}>
      <code>{label}</code>
    </a>
  );
}
