/**
 * @pwngh/economy-webhook
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_READ_TIMEOUT_MS,
  decodeWebhookEvent,
  readBounded,
} from '@pwngh/economy-lab/server';

import {
  DEFAULT_FRESHNESS_WINDOW_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from './signature.js';

import type { WebhookEvent } from '@pwngh/economy-lab/server';
import type { Meter, ReplayStore } from '@pwngh/economy-lab/ports';

/**
 * Turns one provider's raw body into a typed event. `provider` comes from the route, never
 * from the body, so a delivery cannot claim to be from someone else. Throw to refuse: the
 * gate answers `refused` with the thrown message.
 */
export type WebhookDecoder = (input: {
  provider: string;
  body: unknown;
  raw: Uint8Array<ArrayBuffer>;
}) => WebhookEvent;

/** A delivery that proved itself. `raw` is the exact bytes the signature covered. */
export type VerifiedWebhook = {
  status: 'verified';
  provider: string;
  event: WebhookEvent;
  raw: Uint8Array<ArrayBuffer>;
};

/**
 * A delivery this gate has already answered. Reply 200: the provider is retrying something
 * that is done, and a 5xx would only bring it back.
 */
export type DuplicateWebhook = {
  status: 'duplicate';
  provider: string;
  reason: 'stale' | 'replay';
  message: string;
};

/**
 * A delivery that failed to prove itself. Nothing downstream ran.
 *
 * `oversize` and `timeout` are answered before the signature, so they say nothing about whether
 * the delivery was genuine — only that the gate would not buy the memory or the time to find
 * out. A host mapping these to a status wants 413 and 408; the other two are 401 and 400.
 */
export type RefusedWebhook = {
  status: 'refused';
  provider: string;
  reason: 'signature' | 'malformed' | 'oversize' | 'timeout';
  message: string;
};

/**
 * Every answer the gate gives. No delivery is ever an exception: a forgery is `refused`, not a
 * throw. A replay store that is down is not an answer, though, and that failure does reach the
 * caller — refusing would drop a real delivery and verifying would apply it twice.
 */
export type WebhookResult = VerifiedWebhook | DuplicateWebhook | RefusedWebhook;

export type WebhookVerifierOptions = {
  /**
   * The shared secrets both sides hold, newest first.
   *
   * A delivery verifies under any of them, because an inbound signature names no key. Rotation
   * is therefore a window: prepend the new secret, wait for the provider to switch, then drop
   * the old one. At least one is required, and each must be a non-empty string — an unset
   * environment variable is refused here rather than at the first delivery.
   */
  readonly secrets: readonly string[];

  /**
   * Per-provider body decoders. A provider with no entry gets the lab's purchase decoder,
   * which requires `eventId`, `userId`, `amount`, and `source`, and takes an optional `sku`.
   */
  readonly decoders?: Readonly<Record<string, WebhookDecoder>>;

  /**
   * Claims each provider event id once. This is the replay defence.
   *
   * Without one, the only thing that stops a captured delivery from applying twice is the lab's
   * inbox, which dedupes on the same id inside `handleWebhook`. A host that does not end at
   * `handleWebhook` and passes no store here has no replay defence at all.
   */
  readonly replay?: ReplayStore;

  /**
   * How far from now a delivery's timestamp may sit, as a finite count of milliseconds.
   * Defaults to five minutes.
   *
   * This bounds clock skew. It is not a replay bound and was never one: the timestamp arrives
   * in a header the signature does not cover, so a captured delivery re-dated to now verifies
   * as readily as it did the first time. {@link WebhookVerifierOptions.replay} is what refuses
   * the second arrival.
   */
  readonly freshnessWindowMs?: number;

  /**
   * Byte ceiling on a body read off a `Request`, and on `raw` handed to `verifyDelivery`.
   * Defaults to the lab's `DEFAULT_MAX_BODY_BYTES`, so this gate and the lab's own webhook
   * route refuse at the same size.
   *
   * Past it the answer is `refused` with reason `oversize` and the stream is cancelled. The
   * ceiling is checked before the signature, because an unauthenticated caller otherwise
   * chooses how much memory the process buys before it may be told no.
   */
  readonly maxBodyBytes?: number;

  /**
   * Deadline on reading a body off a `Request`, as a finite count of milliseconds. Defaults to
   * the lab's `DEFAULT_READ_TIMEOUT_MS`.
   *
   * Past it the answer is `refused` with reason `timeout` and the stream is cancelled. A body
   * trickled a byte at a time never crosses the ceiling, so the ceiling alone does not reclaim
   * it.
   */
  readonly readTimeoutMs?: number;

  /**
   * Counts each duplicate the gate answers, as `economy.webhook.duplicate` tagged `provider`
   * and `layer` — the same counter under the same name the lab's own route emits.
   */
  readonly meter?: Meter;

  /** Stand-in clock, for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
};

export type WebhookVerifier = {
  /**
   * Reads the raw bytes and both headers off a Fetch `Request`, under the byte ceiling and the
   * read deadline.
   */
  verify(provider: string, request: Request): Promise<WebhookResult>;

  /** The same gate for a host that already holds the bytes and the header values. */
  verifyDelivery(input: {
    provider: string;
    raw: Uint8Array<ArrayBuffer>;
    signature: string | null;
    timestamp: string | number | null;
  }): Promise<WebhookResult>;
};

/**
 * Builds the gate. Every check runs in the order below, and the order is the point:
 *
 * 1. The byte ceiling and the read deadline, over the body as it arrives.
 * 2. The signature, over the raw bytes.
 * 3. The freshness window, against the timestamp header.
 * 4. The decoder, which reads the provider's event id out of the body.
 * 5. The replay claim, on that id.
 *
 * The bounds come first because everything after them costs memory or time an unauthenticated
 * caller would otherwise be choosing. The signature and the window settle before any decoder
 * runs, so provider code never sees a body that failed to prove itself. The claim is last so a
 * forged or stale delivery never burns an event id a genuine redelivery still needs.
 *
 * @example
 * let gate = createWebhookVerifier({ secrets: [WEBHOOK_SECRET], replay: store.replay });
 * let result = await gate.verify('steam', request);
 * result.status // 'verified' | 'duplicate' | 'refused'
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   the same five checks as the server runs them, in the same order.
 */
export function createWebhookVerifier(
  options: WebhookVerifierOptions,
): WebhookVerifier {
  const secrets = options.secrets;
  if (!Array.isArray(secrets) || secrets.length === 0) {
    throw new TypeError(
      'createWebhookVerifier needs at least one secret; none verifies nothing.',
    );
  }
  // An unset environment variable arrives here as undefined, and TextEncoder would turn it into
  // a zero-length key or the letters of its own name. Neither is a secret.
  if (!secrets.every((secret) => typeof secret === 'string' && secret !== '')) {
    throw new TypeError(
      'createWebhookVerifier needs every secret to be a non-empty string.',
    );
  }
  const now = options.now ?? Date.now;
  // Every comparison against NaN is false, so an unchecked bound would mean "never stale",
  // "never too large", "never too slow" — each gate off, silently. `Number(process.env.X)` on
  // an unset variable is NaN, and Infinity spells the same hole in a finite-looking way.
  const windowMs = quantity(
    options.freshnessWindowMs,
    DEFAULT_FRESHNESS_WINDOW_MS,
    'a freshness window',
  );
  const maxBytes = quantity(
    options.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
    'a body ceiling',
  );
  const readTimeoutMs = quantity(
    options.readTimeoutMs,
    DEFAULT_READ_TIMEOUT_MS,
    'a read deadline',
  );
  const decoders = options.decoders ?? {};

  const verifyDelivery = async (input: {
    provider: string;
    raw: Uint8Array<ArrayBuffer>;
    signature: string | null;
    timestamp: string | number | null;
  }): Promise<WebhookResult> => {
    const { provider, raw } = input;

    if (raw.byteLength > maxBytes) {
      return oversize(provider, maxBytes);
    }

    if (!(await verifySignature(raw, input.signature ?? '', secrets))) {
      return {
        status: 'refused',
        provider,
        reason: 'signature',
        message: `Webhook signature for '${provider}' does not match the body.`,
      };
    }

    // A missing header reads as NaN, not 0: Number(null) is a finite epoch and would pass.
    const timestamp =
      input.timestamp === null ? Number.NaN : Number(input.timestamp);
    if (!Number.isFinite(timestamp) || Math.abs(now() - timestamp) > windowMs) {
      countDuplicate(options.meter, provider, 'stale');
      return {
        status: 'duplicate',
        provider,
        reason: 'stale',
        message: `Webhook delivery for '${provider}' is outside the ${windowMs}ms freshness window.`,
      };
    }

    let event: WebhookEvent;
    try {
      event = decode(decoders, provider, raw);
    } catch (error) {
      return {
        status: 'refused',
        provider,
        reason: 'malformed',
        message: messageOf(error),
      };
    }

    if (options.replay !== undefined) {
      const { claimed } = await options.replay.claim(event.eventId);
      if (!claimed) {
        countDuplicate(options.meter, provider, 'replay');
        return {
          status: 'duplicate',
          provider,
          reason: 'replay',
          message: `Webhook event '${event.eventId}' from '${provider}' was accepted already.`,
        };
      }
    }

    return { status: 'verified', provider, event, raw };
  };

  return {
    verifyDelivery,
    verify: async (provider, request) => {
      const body = await readBounded(request, {
        maxBytes,
        timeoutMs: readTimeoutMs,
      });
      if (body.status === 'oversize') {
        return oversize(provider, maxBytes);
      }
      if (body.status === 'timeout') {
        return {
          status: 'refused',
          provider,
          reason: 'timeout',
          message: `Webhook body from '${provider}' did not finish reading within ${readTimeoutMs}ms.`,
        };
      }
      return verifyDelivery({
        provider,
        raw: body.bytes as Uint8Array<ArrayBuffer>,
        signature: request.headers.get(SIGNATURE_HEADER),
        timestamp: request.headers.get(TIMESTAMP_HEADER),
      });
    },
  };
}

function oversize(provider: string, maxBytes: number): RefusedWebhook {
  return {
    status: 'refused',
    provider,
    reason: 'oversize',
    message: `Webhook body from '${provider}' is past the ${maxBytes}-byte ceiling.`,
  };
}

function quantity(
  value: number | undefined,
  fallback: number,
  what: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new TypeError(
      `createWebhookVerifier needs ${what} that is a finite, non-negative number.`,
    );
  }
  return resolved;
}

// The default decoder is the lab's, which reads a purchase. A provider whose callbacks are
// payouts or disputes brings its own.
function decode(
  decoders: Readonly<Record<string, WebhookDecoder>>,
  provider: string,
  raw: Uint8Array<ArrayBuffer>,
): WebhookEvent {
  const text = new TextDecoder().decode(raw);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TypeError(`Webhook body from '${provider}' is not valid JSON.`);
  }
  const decoder = decoders[provider];
  return decoder === undefined
    ? decodeWebhookEvent(provider, body)
    : decoder({ provider, body, raw });
}

// The name and both tags match the lab's own route, so a host that swaps this gate in keeps the
// signal the replay-storm runbook and the ops detector read. Telemetry never fails a delivery.
function countDuplicate(
  meter: Meter | undefined,
  provider: string,
  layer: 'stale' | 'replay',
): void {
  try {
    meter?.count('economy.webhook.duplicate', 1, { provider, layer });
  } catch {
    // Telemetry only.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
