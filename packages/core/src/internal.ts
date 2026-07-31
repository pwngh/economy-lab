/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// No semver contract — these move with the packages that consume them. Every export has a
// named sibling consumer and the surface test pins the list; contract symbols live on ./module.
export { toRequest, writeResponse } from './host.js';
export { seedDemo } from './dev.js';
export { capabilitiesReport, posture } from './inspect.js';
export type { Capabilities } from './inspect.js';
