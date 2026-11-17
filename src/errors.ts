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

import type {
  Outcome,
  Rejection,
  RejectionDetail,
  Success,
} from '#src/contract.ts';

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
  // idempotencyKey. An orderId identifies a unique purchase, so the second charge is declined.
  | 'DUPLICATE_ORDER'
  | 'UNKNOWN_SUBSCRIPTION'
  // The user already has an ACTIVE subscription to this sku/seller. A second one would double-bill.
  | 'ALREADY_SUBSCRIBED'
  // The payout is below the configured minimum (payoutMinimumEarnedMinor).
  | 'BELOW_MINIMUM'
  // A payout was requested before enough time had passed since the user's latest payout update
  // (minimum gap is config payoutMinIntervalMs). The decline carries when the user may retry.
  | 'PAYOUT_TOO_SOON'
  | 'PAYEE_UNVERIFIED'
  // A scheduled maintenance window is in effect, so an end user's discretionary write is declined.
  // Settlement (actor 'system') and operator fixes are never paused. The decline carries `resumesAt`
  // (the window's end) so the caller can tell the user when to retry.
  | 'ECONOMY_PAUSED'
  // The economy checked a spend against the host's catalog port and the sku, price, or recipient
  // split disagreed. Only issued when `Ports.catalog` is configured.
  | 'CATALOG_MISMATCH';

/** Every {@link RejectionCode}, enumerable for docs and exhaustiveness checks. */
export const REJECTION_CODES = [
  'INSUFFICIENT_FUNDS',
  'RISK_DENIED',
  'FUNDS_IMMATURE',
  'NOT_ENTITLED',
  'UNKNOWN_ORDER',
  'DUPLICATE_ORDER',
  'UNKNOWN_SUBSCRIPTION',
  'ALREADY_SUBSCRIBED',
  'BELOW_MINIMUM',
  'PAYOUT_TOO_SOON',
  'PAYEE_UNVERIFIED',
  'ECONOMY_PAUSED',
  'CATALOG_MISMATCH',
] as const satisfies readonly RejectionCode[];

/**
 * Per-code registry of the fields each rejection's `detail` carries. The mapped key set and the
 * keyof-derived field lists are both compile-locked to {@link RejectionDetail}, so this catalog
 * cannot drift from the union.
 */
export const REJECTION_SPEC: {
  readonly [K in RejectionCode]: {
    readonly fields: readonly Exclude<
      keyof Extract<RejectionDetail, { reason: K }>,
      'reason'
    >[];
  };
} = {
  INSUFFICIENT_FUNDS: { fields: ['account', 'need', 'have'] },
  RISK_DENIED: { fields: ['window', 'limitMinor'] },
  FUNDS_IMMATURE: { fields: ['source', 'availableAt'] },
  NOT_ENTITLED: { fields: ['userId', 'sku'] },
  UNKNOWN_ORDER: { fields: ['orderId'] },
  DUPLICATE_ORDER: { fields: ['orderId'] },
  UNKNOWN_SUBSCRIPTION: { fields: ['subscriptionId'] },
  ALREADY_SUBSCRIBED: { fields: ['userId', 'sku'] },
  BELOW_MINIMUM: { fields: ['minimum', 'amount'] },
  PAYOUT_TOO_SOON: { fields: ['retryAt'] },
  PAYEE_UNVERIFIED: { fields: ['userId'] },
  ECONOMY_PAUSED: { fields: ['resumesAt'] },
  CATALOG_MISMATCH: { fields: ['sku', 'field'] },
};

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

  /** A posting named an account the ledger has no row for and won't create implicitly. */
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

  /**
   * A saga was told to move to a state it can't reach from its current one. The request was well
   * formed and the saga's state is what refused, so it maps to 409 — except on the arms that set
   * `retryable`, where a sweep or a racing settle will make the same request work and 503 is the
   * answer.
   */
  INVALID_TRANSITION: 'SAGA.INVALID_TRANSITION',

  /**
   * A netting session that already settled was asked to take another movement. Settlement txn
   * ids derive from the session id, so a settled session can never safely settle again. The
   * caller rotates to a new session id (epoch) instead.
   */
  SESSION_SETTLED: 'SESSION.SETTLED',

  /**
   * A scope's traffic reached a node its router assignment doesn't name. Accepting it would
   * fork the scope's single-writer lane, so the node refuses. The caller re-sends to the owner
   * named in `detail.owner`, which a problem response carries as `owner` beside a 421.
   */
  SESSION_MISROUTED: 'SESSION.MISROUTED',

  UNAUTHORIZED: 'AUTH.UNAUTHORIZED',

  /**
   * A cryptographic signature didn't verify. Thrown when an inbound webhook's
   * HMAC signature fails to match, before any state is changed. Outer layers map this to HTTP 401.
   */
  INVALID_SIGNATURE: 'AUTH.INVALID_SIGNATURE',

  /** The storage layer failed. Reserved for the store paths that mean it (see normalizeError). */
  STORE_FAILURE: 'STORE.FAILURE',

  /**
   * The store protocol was asked for a route the server does not have. The message names the
   * route. Never retryable: the route map is fixed at build time, so the same request fails the
   * same way forever, and a caller retrying on `retryable` would retry a name that will never
   * exist. It means the client and the server disagree about the route map.
   */
  UNKNOWN_ROUTE: 'STORE.UNKNOWN_ROUTE',

  /**
   * The store protocol named a transaction the server is not holding. The message names the id.
   * Never retryable: the session map is per-process, so an id from before a restart, from another
   * instance, or already committed or rolled back is gone for good. The caller opens a new
   * transaction rather than retrying this one.
   */
  UNKNOWN_SESSION: 'STORE.UNKNOWN_SESSION',

  /**
   * An external provider or injected port failed: a payout rail, a dispatcher, a float or
   * reconcile feed. Dead-letter reasons carry this so the operator pages the right owner.
   */
  PROVIDER_FAILURE: 'PROVIDER.FAILURE',

  /**
   * Configuration failed to load or validate. Thrown at startup so a bad config stops
   * the service immediately rather than failing later.
   */
  CONFIG_INVALID: 'CONFIG.INVALID',

  /**
   * The hash chain failed to verify. A stored hash no longer matches the one recomputed from its
   * posting, so the ledger has been tampered with. Thrown before a checkpoint is signed — no
   * attestation is produced over a broken chain. This is a last-resort integrity fault, never an
   * expected "no", so it is a thrown fault rather than a RejectionCode.
   */
  CHAIN_BROKEN: 'CHAIN.BROKEN',
} as const;

/**
 * The union of every {@link ERROR_CODES} value, so a caller matching on `error.code` gets
 * autocompletion and exhaustiveness instead of comparing against free-typed strings.
 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// The brand every EconomyError carries. Symbol.for keys the cross-realm global registry, so two
// resolved copies of this module get the same symbol even though they get different classes.
const BRAND: unique symbol = Symbol.for('@pwngh/economy-lab.EconomyError');

/**
 * The thrown-error type for every fault, carrying one stable {@link ERROR_CODES} code that
 * outer layers use to pick an HTTP status and a retry decision. `retryable` defaults to false:
 * only a throw site that knows a retry is safe sets it.
 *
 * Only `message` is safe to show a caller; `cause` is for logging only, and so is `detail` apart
 * from the named fields {@link wireDetail} publishes.
 *
 * Match with {@link EconomyError.is}, not `instanceof`. Two copies of this package can coexist in
 * one dependency tree, and `instanceof` answers false for an error the other copy threw.
 */
export class EconomyError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  /** The cross-copy brand {@link EconomyError.is} reads. Never serialized: the key is a symbol. */
  readonly [BRAND] = true;

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

  /**
   * True for an EconomyError thrown by any copy of this package. Prefer it to `instanceof`
   * everywhere: npm can resolve a second copy of the lab into one dependency tree, and the
   * prototype chain does not cross that boundary while the brand does.
   *
   * @example
   * try {
   *   await economy.submit(operation);
   * } catch (error) {
   *   if (EconomyError.is(error) && error.retryable) {
   *     // safe to retry; a plain `instanceof` would miss a cross-copy throw
   *   }
   * }
   */
  static is(value: unknown): value is EconomyError {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { [BRAND]?: unknown })[BRAND] === true
    );
  }
}

/**
 * Builds an {@link EconomyError} for the caller to throw — the constructor shorthand every throw
 * site in the package uses. It returns the error rather than throwing: a site can attach it
 * to a dead-letter or reject a promise with it.
 */
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
 * Builds a `rejected` Outcome: the value an operation returns (not throws) when it declines a
 * valid request for one of the expected business reasons in {@link RejectionCode}. The generic
 * pins `fields` to exactly the arm the reason selects.
 */
export function rejected<K extends RejectionCode>(
  reason: K,
  fields: Omit<Extract<RejectionDetail, { reason: K }>, 'reason'>,
): Rejection {
  return {
    status: 'rejected',
    detail: { reason, ...fields } as unknown as RejectionDetail,
  };
}

/**
 * True for `committed` and `duplicate` — both carry the committed transaction. A duplicate is
 * a success replayed. An idempotent redelivery handed the original receipt, so a caller that
 * only cares whether the money moved treats the two alike.
 */
export function isSuccess(outcome: Outcome): outcome is Success {
  return outcome.status === 'committed' || outcome.status === 'duplicate';
}

/**
 * True for the `rejected` arm — an expected business "no", not a fault. The reason and its
 * typed fields are on `outcome.detail`.
 *
 * @example
 * const outcome = await economy.submit(operation);
 * if (outcome.status === 'rejected' && outcome.detail.reason === 'INSUFFICIENT_FUNDS') {
 *   // narrowing on the reason types the detail fields for that arm
 *   console.log(outcome.detail.need, outcome.detail.have);
 * }
 */
export function isRejection(outcome: Outcome): outcome is Rejection {
  return outcome.status === 'rejected';
}

/**
 * Narrows to a success or throws a plain Error naming the rejection — for hosts and tests where
 * a decline is unexpected. Deliberately not an {@link EconomyError}: an assertion failure has no
 * fault code or retry policy.
 *
 * @example
 * const outcome = await economy.submit(operation);
 * const { transaction } = requireSuccess(outcome);
 * // transaction.id names the posting whether the outcome was committed or a duplicate replay
 */
export function requireSuccess(outcome: Outcome): Success {
  if (isSuccess(outcome)) {
    return outcome;
  }
  throw new Error(`Operation was rejected: ${outcome.detail.reason}.`);
}

/**
 * Turns anything caught in a `catch` into an {@link EconomyError}.
 *
 * If it's already one, the function returns it unchanged. Re-wrapping could overwrite its
 * retryable flag and wrongly mark a non-retryable failure as safe to retry.
 *
 * Anything else (a raw exception from a library, the storage layer, etc.) wraps as a retryable
 * STORE.FAILURE. The original is kept in `cause` for logs, so the caller never sees the raw
 * error or its stack trace.
 *
 * `retryable: true` is the answer for a throw this function cannot classify, and a raw throw out
 * of a driver is usually a dropped connection, a deadlock or a timeout — all transient, and all
 * bounded by the attempt caps the workers apply. A failure the package can name never arrives
 * here: it is built with {@link fault} at its throw site, which is where the retry verdict and a
 * message worth reading are both known.
 *
 * @example
 * try {
 *   await store.transact(accounts, work);
 * } catch (error) {
 *   throw normalizeError(error); // an EconomyError either way; raw throws become STORE.FAILURE
 * }
 */
export function normalizeError(error: unknown): EconomyError {
  if (EconomyError.is(error)) {
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

// The shape of a port throw that classified itself: a namespaced string code beside a boolean
// retry verdict, the pair @pwngh/economy-edge assigns onto every Fault and AWS-style SDK errors
// carry too. Read structurally so this module stays free of provider imports. Both properties are
// required — a stray boolean with no code beside it names no failure and is not trusted as a
// verdict.
function carriesRetryVerdict(
  error: unknown,
): error is { code: string; retryable: boolean } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { retryable?: unknown }).retryable === 'boolean'
  );
}

/**
 * {@link normalizeError} for a call into an injected port (a dispatcher, an applier, a feed): a
 * raw throw wraps as PROVIDER.FAILURE instead of STORE.FAILURE, so a dead-letter reason or
 * failure log names the failing subsystem rather than blaming storage.
 *
 * A throw that classified itself — a string `code` beside a boolean `retryable`, the shape
 * `@pwngh/economy-edge` faults carry — keeps its own verdict, so the workers dead-letter a
 * failure the provider already ruled permanent instead of re-driving a call that can never
 * succeed. A throw carrying no verdict wraps as retryable, for the reason
 * {@link normalizeError} gives.
 */
export function normalizePortError(error: unknown): EconomyError {
  if (EconomyError.is(error)) {
    return error;
  }
  return new EconomyError(
    ERROR_CODES.PROVIDER_FAILURE,
    'An injected port failed.',
    {
      cause: error,
      retryable: carriesRetryVerdict(error) ? error.retryable : true,
    },
  );
}

// Codes where the request itself was wrong and the caller can fix it: these map to 400. A route
// or transaction the server does not have belongs here rather than at the 500 default, which
// would blame the server for a request only the caller can correct.
const BAD_REQUEST_CODES = new Set<string>([
  ERROR_CODES.MALFORMED_OPERATION,
  ERROR_CODES.INVALID_AMOUNT,
  ERROR_CODES.AMOUNT_OVERFLOW,
  ERROR_CODES.CURRENCY_MISMATCH,
  ERROR_CODES.UNKNOWN_ROUTE,
  ERROR_CODES.UNKNOWN_SESSION,
]);

// Codes where the request was well formed and the target's own state refused it: these map to
// 409. The caller resolves it and re-sends — wait out the payout settlement window, rotate to a
// new session epoch — so the 500 default would blame the server for a refusal it meant, and a
// retry loop watching for 5xx would hammer a door that is answering correctly.
const CONFLICT_CODES = new Set<string>([
  ERROR_CODES.INVALID_TRANSITION,
  ERROR_CODES.SESSION_SETTLED,
]);

// Codes where the request was refused for WHERE it landed rather than what it asked: the scope's
// traffic reached a node the router does not assign it to. RFC 9110 §15.5.20 is that answer —
// "the request was directed at a server that is unable or unwilling to produce an authoritative
// response", and a client may retry it over a different connection. That is the instruction this
// refusal gives, so it is not the 409 set: 409 says resolve it and re-send here, and re-sending
// here is the one thing that will never work.
const MISDIRECTED_CODES = new Set<string>([ERROR_CODES.SESSION_MISROUTED]);

/**
 * The HTTP status an {@link EconomyError} maps to: 401 for auth/signature failures, 400 for a
 * caller-fixable bad request, 503 for a retryable fault, 421 for a request that reached the wrong
 * node, 409 for a state conflict the caller can resolve, 500 otherwise. This is the canonical
 * mapping createServer applies, exposed so a host running its own endpoint answers the same way.
 *
 * The retry verdict outranks the code sets, because one code can carry both: a `settlePayout`
 * racing the submit sweep raises `SAGA.INVALID_TRANSITION` retryably and keeps its 503, while the
 * same code raised against a payout still inside its settlement window answers 409.
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
  if (error.retryable) {
    return 503;
  }
  if (MISDIRECTED_CODES.has(error.code)) {
    return 421;
  }
  return CONFLICT_CODES.has(error.code) ? 409 : 500;
}

/**
 * The `detail` fields each code may put on the wire, and the only exception to the rule that
 * `detail` never leaves the process. Default-deny: a code absent here publishes nothing, so a
 * refusal added later cannot leak whatever it happened to attach.
 *
 * A field earns its place by being the instruction the refusal gives, not by being useful. A 421
 * tells a caller to send the scope to another node, and without `owner` that is a node the caller
 * cannot name. The scope and the refusing node's own id stay behind: the caller sent the one and
 * addressed the other.
 */
const WIRE_DETAIL: Partial<Record<ErrorCode, readonly string[]>> = {
  [ERROR_CODES.SESSION_MISROUTED]: ['owner'],
};

/**
 * The subset of an error's `detail` a problem response may carry, per {@link WIRE_DETAIL}.
 *
 * Values are taken only when they are JSON scalars, so an allowlisted name cannot become a door
 * for whatever object a throw site attached under it.
 */
export function wireDetail(
  error: EconomyError,
): Record<string, string | number | boolean> {
  const carried: Record<string, string | number | boolean> = {};
  for (const field of WIRE_DETAIL[error.code] ?? []) {
    const value = error.detail[field];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      carried[field] = value;
    }
  }
  return carried;
}
