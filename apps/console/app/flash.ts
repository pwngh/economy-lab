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
 * One-shot outcomes carried across a post-redirect-get: a mutation leaves its message in a module
 * slot, the redirect's next render takes it exactly once, so a refresh never replays it. The app
 * runs entirely in the tab, so the slot needs no cookie — it lives beside the engine it describes.
 */

import { redirect } from 'react-router';

import { DAY_MS } from '~/demo';
import { EconomyError } from '#src/errors.ts';
import { encodeAmount } from '#src/money.ts';
import type { Amount } from '#src/money.ts';

export interface FlashFigure {
  label: string;
  value: string;
}

/**
 * The message a mutation leaves for the page it redirects to. `notice` is a plain confirmation;
 * `outcome` is an engine verdict, its reason code rendered verbatim beside the plain-English line;
 * `invalid` carries per-field validation errors. `form` names the owning form, so a page can render
 * the message in place rather than only in the chrome.
 */
export type Flash =
  | { kind: 'notice'; tone: 'ok' | 'warn'; message: string; form?: string }
  | {
      kind: 'outcome';
      code: string;
      message: string;
      figures?: FlashFigure[];
      form?: string;
    }
  | {
      kind: 'invalid';
      message: string;
      fields: Record<string, string>;
      form?: string;
    };

// Plain-English line for each engine verdict, shown beside the code (which renders verbatim). An
// unmapped code falls back to a tidied form of itself.
const REASON_TEXT: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'The account is short of what this operation needs.',
  FUNDS_IMMATURE:
    'These earned credits are still maturing and cannot be cashed out yet. Advance the clock past the maturity horizon, then try again.',
  RISK_DENIED:
    'This spend tripped the velocity limit: too much value moved inside the window, so the risk screen declined it.',
  DUPLICATE_ORDER:
    'An order with this order id already completed. Reusing an order id is refused, so a buyer is never charged twice.',
  ECONOMY_PAUSED:
    'A maintenance window is in effect, so everyday writes are paused. Settlement and operator fixes still run.',
  BELOW_MINIMUM:
    'This payout is below the smallest amount a seller may cash out at once.',
  PAYOUT_TOO_SOON:
    'A payout was requested too recently: the cash-out interval has not elapsed for this seller.',
  PAYEE_UNVERIFIED:
    'This seller has not cleared payee verification, so a payout cannot be requested yet.',
  'AUTH.UNAUTHORIZED':
    'This actor may not act on that account. A user can only move their own credits.',
  'SAGA.INVALID_TRANSITION':
    'This payout cannot be reversed from its state: a settled payout is done, and a live submitted one is refused until it ages past its provider settlement window.',
};

export function reasonText(code: string): string {
  return (
    REASON_TEXT[code] ??
    `Declined: ${code.replace(/[._]/g, ' ').toLowerCase()}.`
  );
}

function format2(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function dayLabelOf(at: unknown): string {
  const n = Number(at);
  if (!Number.isFinite(n)) {
    return String(at ?? '');
  }
  return n === 0 ? 'day 0' : `day ${Math.round((n / DAY_MS) * 10) / 10}`;
}

// Detail money is a branded Amount; encodeAmount yields "CREDIT:12.34" / "USD:1.00", and the
// decimal is already whole units, so a display figure is one split away.
function amountFigure(label: string, amount: unknown): FlashFigure {
  const text =
    typeof amount === 'object' && amount !== null && 'minor' in amount
      ? encodeAmount(amount as Amount)
      : String(amount ?? '');
  const colon = text.indexOf(':');
  const currency = colon > 0 ? text.slice(0, colon) : '';
  const value = colon > 0 ? text.slice(colon + 1) : text;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { label, value };
  }
  return {
    label,
    value: currency === 'USD' ? `$${format2(n)}` : `${format2(n)} Cr`,
  };
}

function figuresFor(
  reason: string,
  detail: Record<string, unknown>,
): FlashFigure[] {
  switch (reason) {
    case 'INSUFFICIENT_FUNDS':
      return [
        amountFigure('Required', detail.required),
        amountFigure('Available', detail.available),
      ];
    case 'FUNDS_IMMATURE':
      return [amountFigure('Requested', detail.required)];
    case 'BELOW_MINIMUM':
      return [
        amountFigure('Minimum', detail.minimum),
        amountFigure('Requested', detail.requested),
      ];
    case 'PAYOUT_TOO_SOON':
      return [{ label: 'Retry after', value: dayLabelOf(detail.retryAfter) }];
    case 'ECONOMY_PAUSED':
      return [
        {
          label: 'Resumes',
          value: detail.resumesAt == null ? '—' : dayLabelOf(detail.resumesAt),
        },
      ];
    case 'DUPLICATE_ORDER':
      return [{ label: 'Order id', value: String(detail.orderId ?? '') }];
    case 'RISK_DENIED':
      return [{ label: 'Subject', value: String(detail.subject ?? '') }];
    default:
      return [];
  }
}

// A rejected outcome (returned as data) becomes an outcome flash: reason code verbatim, its
// plain-English line, and the typed detail figures.
export function outcomeFlash(
  reason: string,
  detail: Record<string, unknown>,
  form?: string,
): Flash {
  const figures = figuresFor(reason, detail);
  return {
    kind: 'outcome',
    code: reason,
    message: reasonText(reason),
    figures: figures.length ? figures : undefined,
    form,
  };
}

// A thrown fault (the authorization gate, a malformed operation) becomes an outcome flash too, so
// its code renders the same way a rejection's does.
export function faultFlash(err: unknown, form?: string): Flash {
  const code = err instanceof EconomyError ? err.code : 'ERROR';
  const message =
    REASON_TEXT[code] ??
    (err instanceof Error ? err.message : 'The operation failed.');
  return { kind: 'outcome', code, message, form };
}

export function noticeFlash(
  message: string,
  opts?: { tone?: 'ok' | 'warn'; form?: string },
): Flash {
  return {
    kind: 'notice',
    tone: opts?.tone ?? 'ok',
    message,
    form: opts?.form,
  };
}

export function invalidFlash(
  fields: Record<string, string>,
  form?: string,
): Flash {
  return {
    kind: 'invalid',
    message: 'Please fix the highlighted fields.',
    fields,
    form,
  };
}

let pending: Flash | null = null;

// Read-and-clear, called by the chrome loader on every navigation; the clear is what makes the
// message one-shot.
export function takeFlash(): Flash | null {
  const flash = pending;
  pending = null;
  return flash;
}

function sanitizeBack(form: FormData): string {
  const raw = String(form.get('back') ?? '/');
  // Same-origin path only. Reject the protocol-relative `//host` and the backslash `/\host` form,
  // which browsers normalize to `//host` and follow off-site.
  const ok =
    raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\');
  return ok ? raw : '/';
}

// Post-redirect-get with no message: return to the posting page and let the next render show
// whatever is already there.
export function redirectBack(form: FormData): Response {
  return redirect(sanitizeBack(form));
}

// Post-redirect-get carrying one flash: the slot is set, the redirect's render takes it once.
// `to` overrides the form's round-trip destination — for mutations that land where the
// consequence is visible rather than back on the posting page.
export function redirectWithFlash(
  form: FormData,
  flash: Flash,
  to?: string,
): Response {
  pending = flash;
  return redirect(to ?? sanitizeBack(form));
}
