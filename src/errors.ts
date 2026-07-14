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

import type { Outcome, RejectionDetail } from '#src/contract.ts';

/**
 * Reasons a well-formed request is declined on a healthy system, returned as a `rejected`
 * Outcome rather than thrown. Keeping ordinary "no" answers off the thrown-error path keeps
 * them out of error dashboards and alerts.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/outcomes-and-reason-codes/
 *   Outcomes & reason codes} for the full taxonomy.
 */
export type RejectionCode =
  | 'INSUFFICIENT_FUNDS'
  // The fraud/abuse risk check declined this request.
  | 'RISK_DENIED'
  // The funds exist but aren't usable yet (they're still in a holding period).
  | 'FUNDS_IMMATURE'
  | 'NOT_ENTITLED'
  | 'UNKNOWN_ORDER'
  // A spend reused an orderId that already has a completed sale but carried a different
  // idempotencyKey; an orderId identifies a unique purchase, so the second charge is declined.
  | 'DUPLICATE_ORDER'
  | 'UNKNOWN_SUBSCRIPTION'
  // The user already has an ACTIVE subscription to this sku/seller; a second one would double-bill.
  | 'ALREADY_SUBSCRIBED'
  // The payout is below the configured minimum (payoutMinimumEarnedMinor).
  | 'BELOW_MINIMUM'
  // A payout was requested before enough time had passed since the user's previous request
  // (minimum gap is config payoutMinIntervalMs). The decline carries when the user may retry.
  | 'PAYOUT_TOO_SOON'
  | 'PAYEE_UNVERIFIED'
  // A scheduled maintenance window is in effect, so an end user's discretionary write is declined.
  // Settlement (actor 'system') and operator fixes are never paused; the decline carries `resumesAt`
  // (the window's end) so the caller can tell the user when to retry.
  | 'ECONOMY_PAUSED';

/**
 * Codes for thrown faults, as opposed to the expected "no" answers in {@link RejectionCode}.
 * Each value is a stable, namespaced string (e.g. `LEDGER.OVERDRAFT`); always reference these
 * constants, never the bare strings.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/outcomes-and-reason-codes/
 *   Outcomes & reason codes} for how each code maps to an HTTP status and retry decision.
 */
export const ERROR_CODES = {
  /** The request was structurally wrong (missing or invalid fields). */
  MALFORMED_OPERATION: 'OP.MALFORMED',

  /** A money amount was invalid (for example, negative or not a whole minor unit). */
  INVALID_AMOUNT: 'MONEY.INVALID_AMOUNT',

  /**
   * A money amount fell outside the signed 64-bit range the ledger's `BIGINT` columns store,
   * enforced at construction instead of at the database.
   */
  AMOUNT_OVERFLOW: 'MONEY.OVERFLOW',

  /** A posting's debits and credits didn't add up to zero, so the books wouldn't balance. */
  LEDGER_UNBALANCED: 'LEDGER.UNBALANCED',

  UNKNOWN_ACCOUNT: 'LEDGER.UNKNOWN_ACCOUNT',

  /** A single posting tried to combine two different currencies. */
  CURRENCY_MISMATCH: 'LEDGER.CURRENCY_MISMATCH',

  /**
   * A balance that's never supposed to go negative did. Ordinary shortfalls are declined up
   * front as INSUFFICIENT_FUNDS, so reaching this fault means a bug let a balance slip below
   * zero.
   */
  OVERDRAFT: 'LEDGER.OVERDRAFT',

  /**
   * A posting tried to mix custodial funds (money the platform owes users and must hold real money
   * against) with funds it does not owe, such as revenue. Those two kinds must stay in separate
   * accounts, so this is a thrown safety fault deep in the treasury path, never an expected "no".
   */
  COMMINGLING: 'LEDGER.COMMINGLING',

  INVALID_TRANSITION: 'SAGA.INVALID_TRANSITION',

  UNAUTHORIZED: 'AUTH.UNAUTHORIZED',

  /**
   * A cryptographic signature didn't verify. Thrown in src/server.ts when an inbound webhook's
   * HMAC signature fails to match, before any state is changed; outer layers map this to HTTP 401.
   */
  INVALID_SIGNATURE: 'AUTH.INVALID_SIGNATURE',

  STORE_FAILURE: 'STORE.FAILURE',

  PROVIDER_FAILURE: 'PROVIDER.FAILURE',

  /**
   * Configuration failed to load or validate. Thrown at startup so a bad config stops
   * the service immediately rather than failing later.
   */
  CONFIG_INVALID: 'CONFIG.INVALID',

  /**
   * The hash chain failed to verify: a stored hash no longer matches the one recomputed from its
   * posting, so the ledger has been tampered with. Thrown before a checkpoint is signed, so no
   * attestation is produced over a broken chain. Last-resort integrity fault, never an expected
   * "no", hence a thrown fault rather than a RejectionCode.
   */
  CHAIN_BROKEN: 'CHAIN.BROKEN',
} as const;

/**
 * The union of every {@link ERROR_CODES} value, so a caller matching on `error.code` gets
 * autocompletion and exhaustiveness instead of comparing against free-typed strings.
 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * The thrown-error type for every fault, carrying one stable {@link ERROR_CODES} code that
 * outer layers use to pick an HTTP status and a retry decision.
 *
 * Only `message` is safe to show a caller; `detail` and `cause` are for logging only.
 */
export class EconomyError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      detail?: Record<string, unknown>;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'EconomyError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.detail = options?.detail ?? {};
  }
}

export function fault(
  code: ErrorCode,
  message: string,
  options?: {
    cause?: unknown;
    retryable?: boolean;
    detail?: Record<string, unknown>;
  },
): EconomyError {
  return new EconomyError(code, message, options);
}

/**
 * Builds a `rejected` Outcome: the value an operation returns (not throws) when it
 * declines a valid request for one of the expected business reasons in
 * {@link RejectionCode}.
 */
export function rejected(
  reason: RejectionCode,
  detail?: RejectionDetail,
): Extract<Outcome, { status: 'rejected' }> {
  return detail === undefined
    ? { status: 'rejected', reason }
    : { status: 'rejected', reason, detail };
}

/**
 * Turns anything caught in a `catch` into an {@link EconomyError}. If it's already one, returns
 * it unchanged: re-wrapping could overwrite its retryable flag and wrongly mark a non-retryable
 * failure as safe to retry. Anything else (a raw exception from a library, the storage layer,
 * etc.) is wrapped as a retryable STORE.FAILURE, with the original kept in `cause` for logs so
 * the caller never sees the raw error or its stack trace.
 */
export function normalizeError(error: unknown): EconomyError {
  if (error instanceof EconomyError) {
    return error;
  }
  return new EconomyError(
    ERROR_CODES.STORE_FAILURE,
    'An unexpected error occurred.',
    {
      cause: error,
      retryable: true,
    },
  );
}

// Codes where the request itself was wrong and the caller can fix it: these map to 400.
const BAD_REQUEST_CODES = new Set<string>([
  ERROR_CODES.MALFORMED_OPERATION,
  ERROR_CODES.INVALID_AMOUNT,
  ERROR_CODES.AMOUNT_OVERFLOW,
  ERROR_CODES.CURRENCY_MISMATCH,
]);

/**
 * The HTTP status an {@link EconomyError} maps to: 401 for auth/signature failures, 400 for a
 * caller-fixable bad request, 503 for a retryable fault, 500 otherwise. The canonical mapping
 * createServer applies, exposed so a host running its own endpoint answers the same way.
 */
export function statusForError(error: EconomyError): number {
  if (
    error.code === ERROR_CODES.UNAUTHORIZED ||
    error.code === ERROR_CODES.INVALID_SIGNATURE
  ) {
    return 401;
  }
  if (BAD_REQUEST_CODES.has(error.code)) {
    return 400;
  }
  return error.retryable ? 503 : 500;
}
