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

import type { ReactNode } from 'react';
import { Link } from 'react-router';

// Two decimal places with grouping — the house format for every credit and USD figure.
export function fmtAmount(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// A label for a simulated-clock time: the console's times read as elapsed days ("day 0", "day 2.5").
export const DAY_MS = 86_400_000;
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
            <th key={c.key} className={c.num ? 'num' : c.className}>
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
          <Link className="btn" to={href(page - 1)} preventScrollReset>
            ← Prev
          </Link>
        ) : (
          <span className="btn disabled" aria-disabled="true">
            ← Prev
          </span>
        )}
        {page < lastPage ? (
          <Link className="btn" to={href(page + 1)} preventScrollReset>
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
