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

import { DocPage } from '~/components/DocPage.tsx';
import { docBySlug } from '~/content.ts';
import { pageMeta } from '~/seo.ts';

export function meta() {
  const doc = docBySlug('economy/scope-and-non-goals');
  return pageMeta({
    title: `${doc?.title ?? 'Scope and non-goals'} - economy-lab docs`,
    description: doc?.summary,
    path: '/economy/scope-and-non-goals/',
    ogType: 'article',
  });
}

export default function Scope() {
  return <DocPage slug="economy/scope-and-non-goals" />;
}
