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

/**
 * Every refusal, as the reason half of the `ECONOMY_MODULE.<REASON>` code
 * {@link EconomyModuleError} builds. Reference the constant, never the bare string.
 *
 * Most are raised while a module resolves. `ALREADY_LISTENING` and `LISTEN_AFTER_CLOSE` come
 * from the running server, well after boot, and `NOT_FOUND` is thrown only by `@pwngh/economy-cli`.
 */
export const MODULE_ERROR_CODES = {
  DEFAULT_EXPORT: 'DEFAULT_EXPORT',
  UNKNOWN_EXPORT: 'UNKNOWN_EXPORT',
  NOT_A_FUNCTION: 'NOT_A_FUNCTION',
  BAD_WORKER: 'BAD_WORKER',
  UNKNOWN_SWEEP: 'UNKNOWN_SWEEP',
  UNKNOWN_EVENT: 'UNKNOWN_EVENT',
  NOT_YET: 'NOT_YET',
  AUTH_POSTURE: 'AUTH_POSTURE',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_LISTENING: 'ALREADY_LISTENING',
  LISTEN_AFTER_CLOSE: 'LISTEN_AFTER_CLOSE',
  SEAM_SHAPE: 'SEAM_SHAPE',
  ROLE_CONFLICT: 'ROLE_CONFLICT',
} as const;

/**
 * The union of every {@link MODULE_ERROR_CODES} value, so a caller matching on `error.code`
 * gets exhaustiveness instead of comparing against free-typed strings.
 */
export type ModuleErrorCode =
  (typeof MODULE_ERROR_CODES)[keyof typeof MODULE_ERROR_CODES];

// The brand every EconomyModuleError carries. Symbol.for keys the cross-realm global registry, so
// two resolved copies of this package get the same symbol even though they get different classes.
const BRAND: unique symbol = Symbol.for(
  '@pwngh/economy-core.EconomyModuleError',
);

/**
 * A refusal naming the file, the export, and the fix.
 *
 * Match with {@link EconomyModuleError.is}, not `instanceof`. These are thrown here and matched
 * from sibling packages, and `instanceof` answers false for a refusal a second copy threw.
 */
export class EconomyModuleError extends Error {
  readonly code: `ECONOMY_MODULE.${ModuleErrorCode}`;
  readonly file: string;
  readonly export: string;
  /** The cross-copy brand {@link EconomyModuleError.is} reads. Never serialized: the key is a symbol. */
  readonly [BRAND] = true;
  constructor(code: ModuleErrorCode, file: string, exp: string, fix: string) {
    super(`ECONOMY_MODULE.${code} — ${file}, export \`${exp}\`: ${fix}`);
    this.name = 'EconomyModuleError';
    this.code = `ECONOMY_MODULE.${code}`;
    this.file = file;
    this.export = exp;
  }

  /**
   * True for a refusal thrown by any copy of this package. Prefer it to `instanceof`: the CLI
   * renders these by name, and a cross-copy throw would degrade that to a bare stack.
   */
  static is(value: unknown): value is EconomyModuleError {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { [BRAND]?: unknown })[BRAND] === true
    );
  }
}
