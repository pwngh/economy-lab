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

/**
 * The DOM-interop shim now ships with the package (../../../dom-interop.d.ts) so DOM consumers don't
 * re-declare it. This file just pulls it into the app's type-check; see that file for why it exists
 * (TS 5.7 generic Uint8Array vs DOM's SubtleCrypto).
 */
/// <reference path="../../../dom-interop.d.ts" />
