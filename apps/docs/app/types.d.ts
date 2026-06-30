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

import type { ComponentType } from 'react';

declare module '*.mdx' {
  export const frontmatter: Record<string, unknown>;
  const Component: ComponentType;
  export default Component;
}
