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

import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';

/** The retryable provider fault every HTTP-ish adapter throws on a failed call. */
export function transportFault(message: string, error: unknown): Error {
  return fault(ERROR_CODES.PROVIDER_FAILURE, message, {
    cause: normalizeError(error),
    retryable: true,
  });
}
