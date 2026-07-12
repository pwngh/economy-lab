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

/** The project name in one place, so the wordmark and {@link brandize} never disagree. */
const NAME = 'economy-lab';

/**
 * The project wordmark, styled by `.brand` in app.css. Use it directly in JSX or MDX; for plain
 * strings such as frontmatter that DocPage renders as text, use {@link brandize} instead.
 */
export function Brand() {
  return <span className="brand">{NAME}</span>;
}

/**
 * Turn a plain string into nodes with every `economy-lab` wrapped in <Brand />. Returns the string
 * untouched when the name doesn't occur, so it's safe to call on any text. DocPage uses it to brand the
 * frontmatter fields (summary, plain, notes), which aren't MDX and so can't carry markup.
 */
export function brandize(text: string): ReactNode {
  if (!text.includes(NAME)) return text;
  const out: ReactNode[] = [];
  // Key each wordmark by its character offset in the source, which is stable and unique — not the array
  // index the linter warns against. Text segments are raw strings, which React keys on its own.
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
