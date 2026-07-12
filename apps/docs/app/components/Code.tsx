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
 * The kind of thing a piece of inline code names. Each maps to a quiet color (`.code-<variant>` in
 * app.css) from the code-block palette, so an identifier reads the same inline as in a highlighted
 * block. Extend this union and its `.code-<variant>` classes together.
 */
export type CodeVariant = 'type' | 'class' | 'function' | 'value' | 'keyword' | 'const';

/**
 * Quoted code with a handle on how it renders. Plain backtick code (`foo`) still works and is styled
 * by `.prose code`; reach for this component when an identifier wants more than the default — a
 * `variant` that colors it by what it names (a `type`, a `function`, a literal `value`, …), or an
 * `href` that links it to the source or page that defines it.
 */
export function Code({
  variant,
  href,
  children,
}: {
  variant?: CodeVariant;
  href?: string;
  children: ReactNode;
}) {
  const code = <code className={variant ? `code code-${variant}` : 'code'}>{children}</code>;
  if (!href) return code;
  const external = /^https?:/.test(href);
  return (
    <a
      className="code-link"
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {code}
    </a>
  );
}
