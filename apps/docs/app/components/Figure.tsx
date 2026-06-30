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
 * A captioned figure for diagrams — the chart of accounts, the payout saga state machine, the hash
 * chain, and so on. Static markup, zero JS. Used in MDX as
 * `<Figure src="/diagrams/accounts.svg" alt="…" caption="…" />`. `alt` is required (accessibility);
 * `caption` is the visible, optional caption below the image.
 */
export function Figure({ src, alt, caption }: { src: string; alt: string; caption?: ReactNode }) {
  return (
    <figure className="figure">
      <img src={src} alt={alt} loading="lazy" />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
