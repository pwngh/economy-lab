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

const LABELS = { note: 'Note', tip: 'Tip', warning: 'Warning', danger: 'Danger' } as const;

type CalloutType = keyof typeof LABELS;

/**
 * A semantic callout for page content, used in MDX as `<Callout type="warning">…</Callout>`. Static
 * markup, no JavaScript. The four types match the meanings every reference docs site converges on:
 * note (context), tip (recommendation), warning (an easy mistake / non-obvious constraint), danger
 * (irreversible or money-moving footgun). The CSS variants live in app.css under `.callout-<type>`.
 */
export function Callout({ type = 'note', children }: { type?: CalloutType; children: ReactNode }) {
  return (
    <aside className={`callout callout-${type}`}>
      <p className="callout-label">{LABELS[type] ?? LABELS.note}</p>
      <div className="callout-body">{children}</div>
    </aside>
  );
}
