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

// Shared display primitives: money figures, status pills, stat tiles, and the table header, kept
// here so every page renders them the same way.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, isRouteErrorResponse, useRouteLoaderData } from 'react-router';
import { DAY_MS } from '~/demo';
import type { Flash } from '~/flash';

// The origin the console is served under, for absolute OG URLs: an unfurl needs an absolute image
// and page URL, since a crawler cannot resolve a relative one.
const SITE = 'https://economy-lab-docs.pages.dev';

// Route meta: title, matching description, and a full Open Graph + Twitter card, so a shared
// console URL unfurls with its own text over the site card. `args` carries the location for a
// per-route og:url. On the static host only /console/ is independently crawlable (deep links
// bounce through it), so that entry is the one that unfurls; the rest stay client-accurate.
export function pageMeta(
  args: { location: { pathname: string } },
  title: string,
  description: string,
) {
  const full = `${title} — Economy Console`;
  return [
    { title: full },
    { name: 'description', content: description },
    { property: 'og:title', content: full },
    { property: 'og:description', content: description },
    { property: 'og:type', content: 'website' },
    { property: 'og:url', content: `${SITE}/console${args.location.pathname}` },
    { property: 'og:image', content: `${SITE}/og.png` },
    { name: 'twitter:card', content: 'summary_large_image' },
  ];
}

// The hidden field carrying a mutation's round-trip destination: the action redirects back to it
// (flash.ts redirectBack). Every mutating form carries one, so this is the single declaration.
export function BackField({ to }: { to: string }) {
  return <input type="hidden" name="back" value={to} />;
}

// The chrome layout's route id, as React Router derives it from the module path in routes.ts.
// Renaming routes/_chrome.tsx must update this, or useFlash silently reads no loader data.
export const CHROME_ROUTE_ID = 'routes/_chrome';

// The chrome loader takes the one-shot flash (exactly once per navigation); pages that render a
// form-owned message read it from that loader's data rather than taking it again.
export function useFlash(): Flash | null {
  const chrome = useRouteLoaderData<{ flash: Flash | null }>(CHROME_ROUTE_ID);
  return chrome?.flash ?? null;
}

// Per-route error fallback: a page that throws reports here while the chrome, sidebar, and
// sibling routes stay alive. The root boundary remains the last resort.
export function PageError({ error }: { error: unknown }) {
  let title = 'Something went wrong';
  let detail = 'This page could not be loaded. Please try again.';
  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    detail = typeof error.data === 'string' ? error.data : detail;
  } else if (error instanceof Error) {
    detail = error.message;
  }
  return (
    <div className="page">
      <div className="view-head">
        <h2>{title}</h2>
      </div>
      <div className="notice err">{detail}</div>
      <p>
        <Link className="link" to="/">
          Back to overview
        </Link>
      </p>
    </div>
  );
}

// Two decimal places with grouping — the house format for every credit and USD figure.
export function fmtAmount(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// A label for a simulated-clock time: the console's times read as elapsed days ("day 0", "day 2.5").
export function dayLabel(at: number): string {
  return at === 0 ? 'day 0' : `day ${Math.round((at / DAY_MS) * 10) / 10}`;
}

// A figure: optional prefix unit ($), the numeral, optional suffix unit (Cr / currency code).
// Tabular and non-wrapping; `num` is passed through as-is, so a pre-formatted "+50.00" is unchanged.
export function Amount({
  pre,
  num,
  suf,
}: {
  pre?: ReactNode;
  num: ReactNode;
  suf?: ReactNode;
}) {
  return (
    <span className="amt">
      {pre ? <span className="amt-unit amt-pre">{pre}</span> : null}
      <span className="amt-num">{num}</span>
      {suf ? <span className="amt-unit amt-suf">{suf}</span> : null}
    </span>
  );
}

// A credit figure: "1,000.00 Cr".
export function Credits({ value }: { value: number }) {
  return <Amount num={fmtAmount(value)} suf="Cr" />;
}

// A USD figure: "$1,000.00".
export function Usd({ value }: { value: number }) {
  return <Amount pre="$" num={fmtAmount(value)} />;
}

// Name-first entity: "Alice" leads, the raw id trails as a small copyable chip. The display name
// is fabricated from the id (usr_alice → Alice) for the demo cast — the ledger holds no names, so
// this is presentation only, never a fact read from data.
export function entityName(id: string): string {
  const bare = id.replace(/^usr_/, '');
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}
export function Entity({ id }: { id: string }) {
  return (
    <span className="entity">
      <span className="entity-name">{entityName(id)}</span>
      <IdChip id={id} />
    </span>
  );
}

// The raw id, truncated, click-to-copy. The copy handler is a JS-only enhancement; without it
// the chip is still the visible (and hover-titled) id. `copied` resets on leave, so no timer.
export function IdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="id-chip mono"
      aria-label={copied ? `Copied ${id}` : `Copy id ${id}`}
      title={`${id} — click to copy`}
      onClick={() => {
        void navigator.clipboard?.writeText(id);
        setCopied(true);
      }}
      onMouseLeave={() => setCopied(false)}
      onBlur={() => setCopied(false)}
    >
      {copied ? '✓ copied' : id}
    </button>
  );
}

// One flash, rendered wherever it is owned: a plain confirmation, an engine verdict (its reason
// code shown verbatim beside the plain-English line and the typed detail figures), a validation
// summary, or a try-to-break-it tally. Callers place it inside an aria-live region.
export function FlashBanner({ flash }: { flash: Flash }) {
  if (flash.kind === 'notice') {
    return (
      <div className={`notice ${flash.tone === 'warn' ? 'warn' : 'ok'}`}>
        {flash.message}
      </div>
    );
  }
  if (flash.kind === 'invalid') {
    return <div className="notice err">{flash.message}</div>;
  }
  return (
    <div className="notice err outcome">
      <div className="outcome-head">
        <code className="reason-code">{flash.code}</code>
        <span>{flash.message}</span>
      </div>
      {flash.figures && flash.figures.length > 0 ? (
        <dl className="figures">
          {flash.figures.map((f) => (
            <div key={f.label} className="figure">
              <dt>{f.label}</dt>
              <dd className="mono">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

// Stable, unique React keys for a posting's legs. Two legs can share an account and side — a spend
// credits a seller's earned account from both promo and purchased — so repeats get a suffix.
export function withLegKeys<T extends { account: string; side: string }>(
  legs: readonly T[],
): { leg: T; key: string }[] {
  const seen = new Map<string, number>();
  return legs.map((leg) => {
    const base = `${leg.account}:${leg.side}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { leg, key: n === 0 ? base : `${base}#${n}` };
  });
}

// Status pill. `tone` sets the color (green = ok, amber = pending, red = failed, blue = emphasis,
// neutral = plain label); `dot` adds a leading status dot for live state.
type Tone = 'green' | 'amber' | 'red' | 'blue' | 'neutral';
export function StatusPill({
  tone,
  dot,
  children,
}: {
  tone: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={tone === 'neutral' ? 'pill' : `pill ${tone}`}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

// A stat tile: small label, large value, optional caption. `wallet` colors the left edge by credit
// type (purchased/earned/promo/total); omit for a non-credit figure.
export function StatCard({
  label,
  value,
  sub,
  wallet,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  wallet?: 'purchased' | 'earned' | 'promo' | 'total';
}) {
  return (
    <div className="card" data-wallet={wallet}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

// The shared table shape: a small-caps header over rows each page supplies. `num` marks a figure
// column (right-aligned, stable width); `className` sets the header class for anything else.
export type Column = {
  key: string;
  label: ReactNode;
  num?: boolean;
  className?: string;
};
export function DataTable({
  columns,
  children,
  className,
}: {
  columns: Column[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <table className={className ? `table ${className}` : 'table'}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col" className={c.num ? 'num' : c.className}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

// Prev/Next paging, URL-driven: each link is a real GET that re-runs the loader, so the DOM never
// accumulates rows. `baseSearch` carries other query params (e.g. `?user=`) across pages. Renders
// nothing when the list fits one page.
export function Pager({
  offset,
  limit,
  total,
  baseSearch,
}: {
  offset: number;
  limit: number;
  total: number;
  baseSearch?: URLSearchParams;
}) {
  if (total <= limit) {
    return null;
  }
  const page = Math.floor(offset / limit);
  const lastPage = Math.max(0, Math.ceil(total / limit) - 1);
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(total, offset + limit);

  const href = (p: number) => {
    const params = new URLSearchParams(baseSearch);
    if (p <= 0) {
      params.delete('page');
    } else {
      params.set('page', String(p));
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '?';
  };

  return (
    <div className="pager">
      <span className="pager-info dim small">
        {first}–{last} of {total}
      </span>
      <div className="pager-controls">
        {page > 0 ? (
          <Link
            className="btn"
            to={href(page - 1)}
            preventScrollReset
            viewTransition
          >
            ← Prev
          </Link>
        ) : (
          <span className="btn disabled" aria-disabled="true">
            ← Prev
          </span>
        )}
        {page < lastPage ? (
          <Link
            className="btn"
            to={href(page + 1)}
            preventScrollReset
            viewTransition
          >
            Next →
          </Link>
        ) : (
          <span className="btn disabled" aria-disabled="true">
            Next →
          </span>
        )}
      </div>
    </div>
  );
}

// Parse `?page=` (zero-based) into a bounded offset for a given page size. A missing or junk value
// is page 0. The facade re-clamps, so this only has to be roughly sane.
export function pageOffset(url: string, limit: number): number {
  const raw = Number(new URL(url).searchParams.get('page') ?? 0);
  const page = Number.isInteger(raw) && raw > 0 ? raw : 0;
  return page * limit;
}
