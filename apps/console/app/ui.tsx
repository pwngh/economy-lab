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

// Shared display primitives for the console. Three jobs are done here, once, so every page renders
// them identically: figures (a numeral that dominates over a quiet unit, never wrapping), status
// tags, stat tiles, and the table header. Keeping these in one place is what makes a column of
// money line up the same way on Overview as it does on Accounts.

import type { ReactNode } from 'react';

// Two decimal places with grouping — the house format for every credit and USD figure.
export function fmtAmount(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// One day in milliseconds, and a short label for a simulated-clock time: "day 0", or "day 2.5"
// for a fractional day. The console runs on a simulated clock, so times read as elapsed days.
export const DAY_MS = 86_400_000;
export function dayLabel(at: number): string {
  return at === 0 ? 'day 0' : `day ${Math.round((at / DAY_MS) * 10) / 10}`;
}

// The atom every figure is built from: an optional prefix unit ($), the numeral, an optional suffix
// unit (Cr / a currency code). The whole thing is tabular and non-wrapping, and the unit is muted
// and a touch smaller so the number reads first. `num` is taken as-is so a pre-formatted, signed
// leg amount ("+50.00") flows through unchanged.
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

// One tag for every badge on the surface. `tone` carries the status color through the text and rule
// (green = healthy/covered/ok, amber = in-flight/pending, red = failed/shortfall, blue = a neutral
// point of emphasis, neutral = a plain label). `dot` adds the leading status dot used by live
// state; a plain count or kind label leaves it off.
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

// A stat tile: a small uppercase label, one large value, an optional caption. `wallet` keys the
// thin colored left edge to a credit type (purchased / earned / promo / total); omit it for a
// figure that isn't credit-type-specific.
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

// The one table shape: a quiet small-caps header with numeric columns right-aligned and held to a
// stable width, over rows each page supplies. `num` marks a figure column (right-aligned, held to a
// stable width); `className` sets the header class for anything else (e.g. a narrow right-aligned
// marker column). The body is the page's own rows so expansion, links, and per-cell formatting stay
// with the page.
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
