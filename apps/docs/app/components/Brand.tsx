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

/** The literal project name, kept in one place so the wordmark and {@link brandize} never disagree. */
const NAME = 'economy-lab';

/**
 * The project wordmark. Renders `economy-lab` set off subtly from the sans body — the styling lives in
 * `.brand` (app.css). Use it directly in JSX/MDX (`<Brand />`); for plain strings (frontmatter that
 * DocPage renders as text), use {@link brandize}, which wraps each occurrence in this same component.
 */
export function Brand() {
  return <span className="brand">{NAME}</span>;
}

/**
 * Turn a plain string into nodes with every `economy-lab` wrapped in <Brand />. Returns the string
 * untouched when the name doesn't occur, so it's safe to call on any text. This is how DocPage brands
 * the frontmatter-rendered fields (summary, plain, notes), which aren't MDX and so can't carry markup.
 */
export function brandize(text: string): ReactNode {
  if (!text.includes(NAME)) return text;
  const out: ReactNode[] = [];
  // Key each wordmark by its character offset in the source string — stable and unique, and not the
  // array index the linter rightly warns against. Text segments are raw strings (React needs no key).
  let offset = 0;
  text.split(NAME).forEach((part, i) => {
    if (i > 0) {
      out.push(<Brand key={offset} />);
      offset += NAME.length;
    }
    if (part) {
      out.push(part);
      offset += part.length;
    }
  });
  return out;
}
