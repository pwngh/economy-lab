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

import type { Outcome } from '#src/contract.ts';

/**
 * The reasons an operation can be turned down even though the request itself was
 * well-formed and the system is healthy. A rejection is normal, expected data: it
 * comes back as a `rejected` Outcome that the caller inspects and handles (for
 * example, showing the user "not enough funds"), not as a thrown error.
 *
 * This is deliberately kept separate from the thrown faults in `ERROR_CODES`. For
 * example, "the user can't afford this" is checked up front and returned here as
 * INSUFFICIENT_FUNDS; it never reaches the deeper OVERDRAFT fault, which only fires
 * if a balance somehow went negative anyway. Keeping ordinary "no" answers like
 * UNKNOWN_ORDER and UNKNOWN_SUBSCRIPTION out of the thrown-error path keeps them
 * from cluttering error dashboards and alerts.
 */
export type RejectionCode =
  // The account doesn't have enough money to cover the request.
  | 'INSUFFICIENT_FUNDS'
  // The fraud/abuse risk check declined this request.
  | 'RISK_DENIED'
  // The funds exist but aren't usable yet (they're still in a holding period).
  | 'FUNDS_IMMATURE'
  // The user doesn't own the item or feature the request needs.
  | 'NOT_ENTITLED'
  // No sale was found for the order the request refers to.
  | 'UNKNOWN_ORDER'
  // A spend reused an orderId that already has a completed sale, but carried a different
  // idempotencyKey (the value that lets a retried request run at most once: a repeat with
  // the same key is recognized and not re-applied). The orderId is what identifies a unique
  // purchase, so a second charge for the same order is declined as a normal "no" (returned),
  // not a thrown fault — it is an expected client mistake (a retry that lost its original
  // idempotency key), not a bug.
  | 'DUPLICATE_ORDER'
  // No subscription was found matching the request.
  | 'UNKNOWN_SUBSCRIPTION'
  // The user already has an ACTIVE subscription to this sku/seller; a second one would double-bill.
  | 'ALREADY_SUBSCRIBED'
  // A payout was requested for less than the smallest amount that's allowed to be
  // paid out (the minimum is set in config).
  | 'BELOW_MINIMUM'
  // A payout was requested before enough time had passed since the user's previous
  // request (the minimum gap is the config value payoutMinIntervalMs). Returned as a
  // normal declined Outcome, not thrown — the caller shows the user when they may retry.
  | 'PAYOUT_TOO_SOON';

/**
 * The codes for thrown faults — things that genuinely went wrong, as opposed to the
 * expected "no" answers in {@link RejectionCode}. Each value is a stable, namespaced
 * string (like `LEDGER.OVERDRAFT`) so callers and dashboards can match on a fixed code
 * instead of on a free-text message. Code in this project always uses these constants;
 * it never writes the bare strings inline.
 */
export const ERROR_CODES = {
  // The request was structurally wrong (missing or invalid fields).
  MALFORMED_OPERATION: 'OP.MALFORMED',

  // A money amount was invalid (for example, negative or not a whole minor unit).
  INVALID_AMOUNT: 'MONEY.INVALID_AMOUNT',

  // A posting's debits and credits didn't add up to zero, so the books wouldn't balance.
  LEDGER_UNBALANCED: 'LEDGER.UNBALANCED',

  // A posting referenced an account that doesn't exist.
  UNKNOWN_ACCOUNT: 'LEDGER.UNKNOWN_ACCOUNT',

  // A multi-step workflow (a saga) was told to move to a state it can't reach from its
  // current one.
  INVALID_TRANSITION: 'SAGA.INVALID_TRANSITION',

  // The caller isn't permitted to perform this action.
  UNAUTHORIZED: 'AUTH.UNAUTHORIZED',

  // A cryptographic signature didn't verify. Thrown in src/server.ts when an inbound
  // webhook's HMAC signature (a keyed hash proving the sender holds the shared secret)
  // fails to match, before any state is changed; outer layers map this to HTTP 401.
  INVALID_SIGNATURE: 'AUTH.INVALID_SIGNATURE',

  // The underlying storage layer (database, etc.) failed.
  STORE_FAILURE: 'STORE.FAILURE',

  // An external service we depend on (such as a payment processor) failed.
  PROVIDER_FAILURE: 'PROVIDER.FAILURE',

  // A balance that's never supposed to go negative did. This is a last-resort safety
  // check deep in the posting code, not the user-facing "not enough funds" answer:
  // affordability is checked up front and returned as the INSUFFICIENT_FUNDS rejection,
  // so reaching this fault means a bug let a balance slip below zero.
  OVERDRAFT: 'LEDGER.OVERDRAFT',

  // A single posting tried to combine two different currencies, which isn't allowed.
  CURRENCY_MISMATCH: 'LEDGER.CURRENCY_MISMATCH',

  // Configuration failed to load or validate. Thrown at startup so a bad config stops
  // the service immediately rather than failing later.
  CONFIG_INVALID: 'CONFIG.INVALID',

  // A payout was requested before the minimum interval since the user's last request had
  // elapsed. This is the namespaced, status-mappable code that mirrors the PAYOUT_TOO_SOON
  // rejection; the request path RETURNS the rejection (it is an expected "no"), so this code
  // is for status mapping/observability, not for throwing on the affordability path.
  PAYOUT_TOO_SOON: 'PAYOUT.TOO_SOON',

  // The hash chain failed to verify: a stored hash no longer matches the one recomputed from
  // its posting, so the ledger has been tampered with. Thrown before a checkpoint is signed so
  // an attestation is never produced over a broken chain. A last-resort integrity fault, never
  // an expected "no", so it is a thrown fault rather than a RejectionCode.
  CHAIN_BROKEN: 'CHAIN.BROKEN',

  // A posting tried to mix funds the platform actually owes its users and must hold real money
  // against (custodial funds) with funds it does not owe them, such as revenue. Those two kinds
  // of money must stay in separate accounts, so this is a thrown safety fault deep in the
  // treasury path, never an expected "no".
  COMMINGLING: 'LEDGER.COMMINGLING',
} as const;

/**
 * The thrown-error type for every fault in this system. It carries one of the stable
 * {@link ERROR_CODES} codes, which outer layers use to decide an HTTP status, whether
 * to retry, and what to log.
 *
 * Only `message` is considered safe to show to a caller. `detail` and `cause` may hold
 * internal information, so they are for logging only — don't surface them in a response.
 */
export class EconomyError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  constructor(
    code: string,
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

/** Build an {@link EconomyError} to throw when something has actually gone wrong. */
export function fault(
  code: string,
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
 * Build a `rejected` Outcome: the value an operation returns (not throws) when it
 * declines a valid request for one of the expected business reasons in
 * {@link RejectionCode}.
 */
export function rejected(
  reason: RejectionCode,
  detail?: Record<string, unknown>,
): Extract<Outcome, { status: 'rejected' }> {
  return detail === undefined
    ? { status: 'rejected', reason }
    : { status: 'rejected', reason, detail };
}

/**
 * Turn anything caught in a `catch` block into an {@link EconomyError}. If it's already
 * one, return it unchanged — this matters because re-wrapping could overwrite its
 * retryable flag and wrongly mark a non-retryable failure as safe to retry. Anything
 * else (a raw exception from a library, the storage layer, etc.) is wrapped as a
 * retryable STORE.FAILURE, with the original kept in `cause` for logs so the caller
 * never sees the raw error or its stack trace.
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
