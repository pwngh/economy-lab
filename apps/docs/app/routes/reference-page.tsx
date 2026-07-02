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

import { useParams } from 'react-router';

import { DocPage } from '~/components/DocPage.tsx';
import { docBySlug } from '~/content.ts';
import { pageMeta } from '~/seo.ts';

export function meta({ params }: { params: { slug?: string } }) {
  const doc = params.slug ? docBySlug(`economy/reference/${params.slug}`) : undefined;
  if (!doc) return [{ title: 'Not found - economy-lab docs' }];
  return pageMeta({
    title: `${doc.title} - economy-lab docs`,
    description: doc.summary,
    path: `/${doc.slug}/`,
    ogType: 'article',
  });
}

export default function ReferencePage() {
  const { slug } = useParams();
  return <DocPage slug={`economy/reference/${slug ?? ''}`} />;
}
