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

import { sourceUrl } from '~/repo.ts';

/**
 * An inline prose link to a source symbol on GitHub at the pinned commit, used in MDX as
 * `<SourceLink to="src/ports.ts#L599-L605 · SagaStore.advance" />`. Pass `children` to override the
 * visible label when the symbol is already named in the sentence.
 *
 * The href runs through {@link sourceUrl}, so re-pinning {@link REPO_REF} updates every inline link
 * and every `sourceRefs` chip at once. An unresolvable chip renders unlinked.
 */
export function SourceLink({
  to,
  children,
}: {
  to: string;
  children?: ReactNode;
}) {
  const href = sourceUrl(to);
  const symbol = to.split('·')[1]?.trim();
  const path = to.split('·')[0]?.trim() ?? to;
  const label = children ?? symbol ?? path.split('/').pop()?.split('#')[0] ?? path;
  if (!href) return <code>{label}</code>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      <code>{label}</code>
    </a>
  );
}
