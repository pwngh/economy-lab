/**
 * @pwngh/economy-lab-docs
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import type { ReactNode } from 'react';

/**
 * In-document SVG diagrams for the concept pages — the chart of accounts, the payout saga state
 * machine, and the hash chain. Authored as components (not <img> via {@link Figure}) so the SVG is
 * part of the page DOM and themes from the same CSS variables as everything else: a manual
 * `data-theme` toggle recolors a diagram exactly as it recolors a Shiki code block, which an
 * <img>-loaded SVG can't do. Static markup, zero client JS — rendered once at prerender. Colors and
 * type live in app.css under `.diagram`; this file is geometry and labels only.
 *
 * Each export is used in MDX with no import (registered in `MDX_COMPONENTS`, see DocPage). The figure
 * caption is the visible explanation; `aria-label` is the accessible summary for non-visual readers.
 */

function Diagram({
  viewBox,
  label,
  caption,
  children,
}: {
  viewBox: string;
  label: string;
  caption: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="figure diagram">
      <svg viewBox={viewBox} role="img" aria-label={label} xmlns="http://www.w3.org/2000/svg">
        {children}
      </svg>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/** Shared arrowhead marker. Referenced as `markerEnd="url(#dgm-arrow)"`. */
function ArrowDefs() {
  return (
    <defs>
      <marker
        id="dgm-arrow"
        viewBox="0 0 8 8"
        refX="7"
        refY="4"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path className="d-arrow" d="M0,0 L8,4 L0,8 z" />
      </marker>
    </defs>
  );
}

/** A labelled account box: a name (line 1) over a currency/role note (line 2). */
function Acct({
  x,
  y,
  w,
  name,
  note,
  variant,
}: {
  x: number;
  y: number;
  w: number;
  name: string;
  note: string;
  variant?: 'usd';
}) {
  const cx = x + w / 2;
  return (
    <g>
      <rect
        className={`d-box${variant === 'usd' ? ' usd' : ''}`}
        x={x}
        y={y}
        width={w}
        height={44}
        rx={6}
      />
      <text className="d-name mono" x={cx} y={y + 19} textAnchor="middle">
        {name}
      </text>
      <text className="d-sub" x={cx} y={y + 33} textAnchor="middle">
        {note}
      </text>
    </g>
  );
}

/**
 * The fixed chart of accounts: a user's three CREDIT accounts and the nine platform ("house")
 * accounts, with `spendable` backed one-for-one by `TRUST_CASH`. Mirrors `src/accounts.ts`.
 */
export function ChartOfAccounts() {
  return (
    <Diagram
      viewBox="0 0 760 250"
      label="The chart of accounts. A user holds three CREDIT accounts: spendable (backed by trust cash), earned, and promo. The platform holds nine house accounts: the USD accounts trust_cash, usd_clearing, and revenue_usd; and the CREDIT accounts stored_value, promo_float, receivable, revenue, payout_reserve, and opening_equity. A user's spendable balance is backed one-for-one by trust_cash."
      caption="The fixed chart of accounts. A user's spendable credits are the only balance backed one-for-one by USD in trust_cash; every other account is the platform's own cash, revenue, or a contra entry."
    >
      <ArrowDefs />

      <text className="d-head" x={135} y={22} textAnchor="middle">
        USER ACCOUNTS
      </text>
      <Acct x={40} y={40} w={190} name="spendable" note="CREDIT, backed by trust" />
      <Acct x={40} y={96} w={190} name="earned" note="CREDIT, owed to seller" />
      <Acct x={40} y={152} w={190} name="promo" note="CREDIT, expires if unspent" />

      <text className="d-head" x={527} y={22} textAnchor="middle">
        PLATFORM (HOUSE) ACCOUNTS
      </text>
      <Acct x={320} y={40} w={130} name="TRUST_CASH" note="USD" variant="usd" />
      <Acct x={462} y={40} w={130} name="USD_CLEARING" note="USD" variant="usd" />
      <Acct x={604} y={40} w={130} name="REVENUE_USD" note="USD" variant="usd" />
      <Acct x={320} y={96} w={130} name="STORED_VALUE" note="CREDIT" />
      <Acct x={462} y={96} w={130} name="PROMO_FLOAT" note="CREDIT" />
      <Acct x={604} y={96} w={130} name="RECEIVABLE" note="CREDIT" />
      <Acct x={320} y={152} w={130} name="REVENUE" note="CREDIT" />
      <Acct x={462} y={152} w={130} name="PAYOUT_RESERVE" note="CREDIT" />
      <Acct x={604} y={152} w={130} name="OPENING_EQUITY" note="CREDIT" />

      {/* spendable is backed one-for-one by trust_cash. This draws the solvency invariant. */}
      <line className="d-edge" x1={230} y1={62} x2={316} y2={62} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={273} y={55} textAnchor="middle">
        backed one-for-one
      </text>

      <rect className="d-box usd" x={40} y={214} width={16} height={12} rx={2} />
      <text className="d-sub" x={62} y={224}>
        USD account
      </text>
      <rect className="d-box" x={170} y={214} width={16} height={12} rx={2} />
      <text className="d-sub" x={192} y={224}>
        CREDIT account
      </text>
    </Diagram>
  );
}

/** A saga state box. */
function State({
  x,
  y,
  name,
  sub,
  variant,
}: {
  x: number;
  y: number;
  name: string;
  sub?: string;
  variant?: 'ok' | 'bad';
}) {
  const w = 132;
  const cx = x + w / 2;
  return (
    <g>
      <rect
        className={`d-box${variant ? ` ${variant}` : ''}`}
        x={x}
        y={y}
        width={w}
        height={44}
        rx={6}
      />
      <text className="d-name mono" x={cx} y={sub ? y + 19 : y + 27} textAnchor="middle">
        {name}
      </text>
      {sub ? (
        <text className="d-sub" x={cx} y={y + 33} textAnchor="middle">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

/**
 * The payout saga state machine: `RESERVED → SUBMITTED → SETTLED`, with a force-fail branch to
 * `FAILED` that returns the reserve to the seller. Mirrors `lifecycles` and `src/worker/payouts.ts`.
 */
export function PayoutSaga() {
  return (
    <Diagram
      viewBox="0 0 760 250"
      label="The payout saga state machine. A live payout starts RESERVED. The payouts sweep converts the reserve to USD, calls the rail, and advances it to SUBMITTED. The provider's settlement webhook advances SUBMITTED to SETTLED, a terminal state. From RESERVED or SUBMITTED a timeout, exhausted attempts, or an operator reversal force-fail the saga to FAILED, returning the reserve to the seller's earned account. SagaState also declares REQUESTED, but a live payout opens already RESERVED."
      caption="The payout saga. Each transition is a compare-and-set that posts its money in the same transaction, so a re-driven step pays at most once. SETTLED and FAILED are terminal; the reserve is released exactly once."
    >
      <ArrowDefs />

      <State x={70} y={48} name="RESERVED" sub="reserve held" />
      <State x={314} y={48} name="SUBMITTED" sub="sent to rail" />
      <State x={558} y={48} name="SETTLED" sub="terminal" variant="ok" />
      <State x={314} y={158} name="FAILED" sub="terminal" variant="bad" />

      {/* forward path */}
      <line className="d-edge" x1={202} y1={70} x2={310} y2={70} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={256} y={56} textAnchor="middle">
        payouts sweep
      </text>
      <text className="d-elabel" x={256} y={92} textAnchor="middle">
        reserve → USD
      </text>

      <line className="d-edge" x1={446} y1={70} x2={554} y2={70} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={500} y={56} textAnchor="middle">
        settlement
      </text>
      <text className="d-elabel" x={500} y={92} textAnchor="middle">
        webhook
      </text>

      {/* force-fail branch */}
      <path
        className="d-edge bad"
        d="M136,92 C136,150 250,150 318,168"
        fill="none"
        markerEnd="url(#dgm-arrow)"
      />
      <line className="d-edge bad" x1={380} y1={92} x2={380} y2={154} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={470} y={150} textAnchor="start">
        timeout, max attempts, reverse
      </text>
      <text className="d-elabel" x={470} y={166} textAnchor="start">
        → reserve returns to earned
      </text>

      <text className="d-note" x={70} y={232}>
        SagaState also declares REQUESTED; a live payout opens already RESERVED, in the same
        transaction as the reservation.
      </text>
    </Diagram>
  );
}

/** A small hash-link box in an account's chain. */
function Link({
  x,
  y,
  text,
  variant,
}: {
  x: number;
  y: number;
  text: string;
  variant?: 'genesis' | 'head';
}) {
  const w = 70;
  return (
    <g>
      <rect
        className={`d-box${variant === 'head' ? ' head' : variant === 'genesis' ? ' ghost' : ''}`}
        x={x}
        y={y}
        width={w}
        height={30}
        rx={5}
      />
      <text className="d-hash mono" x={x + w / 2} y={y + 19} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}

/**
 * The integrity construction: each account's postings form a hash chain (every link commits to the
 * prior head); the current heads fold into one Merkle root that the worker signs as a checkpoint.
 * Mirrors `integrity` and `src/chain.ts`.
 */
export function HashChain() {
  // chain link x positions, shared by both rows
  const xs = [40, 150, 260, 370];
  const headFold = (yFrom: number, xFrom: number) =>
    `M${xFrom},${yFrom} C500,${yFrom} 500,150 556,150`;
  return (
    <Diagram
      viewBox="0 0 760 300"
      label="The integrity construction. Each account's postings form a hash chain: a genesis value of 64 zeros, then links whose hash commits to the account's prior head. Account A has three links; account B has two. Each account's current head folds into a single Merkle root, which the worker signs as a checkpoint using an Ed25519 key. Altering any entry stops its hash re-deriving; re-sealing the whole chain produces a root that no longer matches the signed checkpoint."
      caption="Two layers, two attacks. The per-account hash chain catches an edited row that still balances; the signed Merkle checkpoint catches a wholesale re-seal. Both surface as chainIntact in a ProveReport."
    >
      <ArrowDefs />

      <text className="d-head" x={40} y={30} textAnchor="start">
        ACCOUNT A
      </text>
      <Link x={xs[0]} y={42} text="0000…" variant="genesis" />
      <Link x={xs[1]} y={42} text="a1b2…" />
      <Link x={xs[2]} y={42} text="c3d4…" />
      <Link x={xs[3]} y={42} text="e5f6…" variant="head" />

      <text className="d-head" x={40} y={104} textAnchor="start">
        ACCOUNT B
      </text>
      <Link x={xs[0]} y={116} text="0000…" variant="genesis" />
      <Link x={xs[1]} y={116} text="9a8b…" />
      <Link x={xs[2]} y={116} text="7c6d…" variant="head" />

      {/* chain arrows */}
      <line className="d-edge" x1={110} y1={57} x2={148} y2={57} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge" x1={220} y1={57} x2={258} y2={57} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge" x1={330} y1={57} x2={368} y2={57} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge" x1={110} y1={131} x2={148} y2={131} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge" x1={220} y1={131} x2={258} y2={131} markerEnd="url(#dgm-arrow)" />

      <text className="d-note" x={40} y={178}>
        each link = hash(account's legs + prior head); the first starts from genesis (64 zeros)
      </text>

      {/* heads fold into the Merkle root */}
      <path className="d-edge" d={headFold(57, 440)} fill="none" markerEnd="url(#dgm-arrow)" />
      <path className="d-edge" d={headFold(131, 330)} fill="none" markerEnd="url(#dgm-arrow)" />

      <g>
        <rect className="d-box head" x={556} y={128} width={150} height={44} rx={6} />
        <text className="d-name mono" x={631} y={147} textAnchor="middle">
          Merkle root
        </text>
        <text className="d-sub" x={631} y={161} textAnchor="middle">
          folds every head
        </text>
      </g>

      <line className="d-edge" x1={631} y1={172} x2={631} y2={206} markerEnd="url(#dgm-arrow)" />

      <g>
        <rect className="d-box ok" x={541} y={208} width={180} height={44} rx={6} />
        <text className="d-name mono" x={631} y={227} textAnchor="middle">
          signed checkpoint
        </text>
        <text className="d-sub" x={631} y={241} textAnchor="middle">
          Ed25519 signature
        </text>
      </g>

      <text className="d-note" x={40} y={276}>
        Tamper a row → its hash stops re-deriving. Re-seal the chain → the new root ≠ the signed
        checkpoint.
      </text>
    </Diagram>
  );
}

/** A general labelled box: a name over an optional one-line note. Used by the flow diagrams below. */
function Pill({
  x,
  y,
  w,
  h = 44,
  name,
  sub,
  variant,
  mono = true,
}: {
  x: number;
  y: number;
  w: number;
  h?: number;
  name: string;
  sub?: string;
  variant?: 'usd' | 'head' | 'ok' | 'bad' | 'ghost' | 'band';
  mono?: boolean;
}) {
  const cx = x + w / 2;
  return (
    <g>
      <rect
        className={`d-box${variant ? ` ${variant}` : ''}`}
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
      />
      <text
        className={`d-name${mono ? ' mono' : ''}`}
        x={cx}
        y={sub ? y + 19 : y + Math.round(h / 2) + 4}
        textAnchor="middle"
      >
        {name}
      </text>
      {sub ? (
        <text className="d-sub" x={cx} y={y + 33} textAnchor="middle">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

/**
 * The dual-rate ladder: `buy` sits above `par`, and the gap between them is the platform spread.
 * `payout` equals `par`. Vertical position encodes USD per credit, so the shaded band literally is the
 * margin. Mirrors `money-model` and the `Rates` port.
 */
export function RateLadder() {
  return (
    <Diagram
      viewBox="0 0 760 206"
      label="The dual-rate ladder. A user pays the buy rate of about $0.0083 per credit (roughly 120 credits per dollar). The platform backs, redeems, and pays out each credit at par, about $0.005 per credit (roughly 200 credits per dollar); payout equals par. The vertical gap between buy and par is the platform spread, about 40 percent, the platform's only margin."
      caption="Buy sits above par; the shaded gap between them is the spread, the platform's only margin. A $10 purchase becomes 1,200 credits, of which $6.00 is set aside as backing at par and $4.00 is the platform's, taken once at purchase."
    >
      <ArrowDefs />

      {/* axis: higher = more USD per credit */}
      <line className="d-edge" x1={148} y1={190} x2={148} y2={34} markerEnd="url(#dgm-arrow)" />
      <text className="d-sub" transform="rotate(-90 130 112)" x={130} y={112} textAnchor="middle">
        USD per credit
      </text>

      <Pill
        x={186}
        y={36}
        w={446}
        name="buy = $0.0083 / credit"
        sub="what a user pays (≈120 credits per $1)"
        mono={false}
      />
      <rect className="d-box band" x={186} y={82} width={446} height={56} rx={6} />
      <text className="d-name" x={409} y={106} textAnchor="middle">
        the spread ≈ 40%
      </text>
      <text className="d-sub" x={409} y={123} textAnchor="middle">
        the platform's only margin
      </text>
      <Pill
        x={186}
        y={142}
        w={446}
        name="par = payout = $0.005 / credit"
        sub="backing and creator settlement (≈200 per $1)"
        mono={false}
      />
    </Diagram>
  );
}

/**
 * The submit pipeline: an operation is validated and authorized, then the idempotency claim gates a
 * repeat, the handler runs by kind, and its ledger writes commit with the recorded outcome. Mirrors
 * `the-economy` and `src/economy.ts`.
 */
export function SubmitPipeline() {
  const w = 106;
  const xs = [8, 128, 248, 368, 488, 608];
  const stages: [string, string, ('head' | undefined)?][] = [
    ['submit(op)', 'request in'],
    ['validate', 'shape · key'],
    ['authorize', 'actor may?'],
    ['idempotency', 'the claim gate', 'head'],
    ['handler', 'by kind'],
    ['commit', 'ledger + events'],
  ];
  return (
    <Diagram
      viewBox="0 0 760 92"
      label="The submit pipeline. An operation enters submit, is validated (its shape and a non-empty idempotency key), then authorized (may this actor run this kind?). The idempotency claim gates a repeat: an already-used key replays the first outcome instead of running again. A fresh request reaches its handler, selected by the operation's kind, whose ledger writes and the events it emits commit together, with the outcome recorded under the key."
      caption="One pass through submit. Validation and authorization run before any money moves; the idempotency claim makes a retried call replay the first outcome; the handler's ledger writes, emitted events, and the recorded outcome all commit in one transaction."
    >
      <ArrowDefs />

      {stages.map(([name, sub, variant], i) => (
        <Pill key={name} x={xs[i]} y={24} w={w} name={name} sub={sub} variant={variant} />
      ))}
      {xs.slice(0, -1).map((x, i) => (
        <line
          key={x}
          className="d-edge"
          x1={x + w}
          y1={46}
          x2={xs[i + 1]}
          y2={46}
          markerEnd="url(#dgm-arrow)"
        />
      ))}
    </Diagram>
  );
}

/**
 * The background worker: one `Scheduler` drives the ten sweeps named in `SWEEP_NAMES`, each one safe
 * to re-run. The array order is both the run order and the order results return in. Mirrors
 * `background-worker` and `src/worker`.
 */
export function WorkerSweeps() {
  const lw = 148;
  const left = 30;
  const right = 582;
  const rows = [20, 80, 140, 200, 260];
  const sched = { x: 312, y: 140, w: 136 };
  const lefts: [string, string][] = [
    ['payouts', 'advance sagas'],
    ['subscriptions', 'renew or lapse'],
    ['treasury', 'measure backing'],
    ['feeSweep', 'realize fees'],
    ['checkpointVerify', 're-check last'],
  ];
  const rights: [string, string][] = [
    ['checkpoint', 'seal a new one'],
    ['relay', 'outbox → dispatcher'],
    ['drainInbox', 'apply inbound'],
    ['reconcile', 'match provider'],
    ['promos', 'claw back expired'],
  ];
  return (
    <Diagram
      viewBox="0 0 760 314"
      label="The background worker. A single Scheduler drives ten sweeps, each on its own interval: payouts advances payout sagas; subscriptions renews or lapses a due subscription; treasury measures whether held USD still backs spendable credit; feeSweep realizes the matured fee surplus into cash; checkpointVerify re-checks the previous signed checkpoint; checkpoint seals a fresh one; relay drains the outbox to the dispatcher; drainInbox applies received provider events; reconcile compares the provider's records against the ledger; and promos claws back the unspent part of an expired grant. Each sweep claims a bounded batch of due work and is safe to re-run."
      caption="One scheduler drives the ten sweeps of SWEEP_NAMES, in array order. Each claims a bounded batch of due rows, advances each one step, and is safe to re-run, so a re-driven sweep repeats no effect and a crash mid-cycle costs nothing."
    >
      <ArrowDefs />

      <Pill
        x={sched.x}
        y={sched.y}
        w={sched.w}
        name="scheduler"
        sub="per-interval"
        variant="head"
      />

      {lefts.map(([name, sub], i) => (
        <g key={name}>
          <Pill x={left} y={rows[i]} w={lw} name={name} sub={sub} />
          <line
            className="d-edge"
            x1={sched.x}
            y1={sched.y + 22}
            x2={left + lw}
            y2={rows[i] + 22}
            markerEnd="url(#dgm-arrow)"
          />
        </g>
      ))}
      {rights.map(([name, sub], i) => (
        <g key={name}>
          <Pill x={right} y={rows[i]} w={lw} name={name} sub={sub} />
          <line
            className="d-edge"
            x1={sched.x + sched.w}
            y1={sched.y + 22}
            x2={right}
            y2={rows[i] + 22}
            markerEnd="url(#dgm-arrow)"
          />
        </g>
      ))}
    </Diagram>
  );
}

/**
 * Credit maturity: an account's funds are dated lots. Spends drain oldest-first, so the live balance
 * is the newest run of lots (the tail); the matured part of that tail is what a cash-out may draw.
 * Mirrors `src/maturity.ts`.
 */
export function CreditMaturity() {
  const xs = [30, 124, 218, 312, 406, 500, 594];
  const w = 84;
  const matLine = 495; // between the matured tail and the still-clearing tail
  return (
    <Diagram
      viewBox="0 0 760 262"
      label="Credit maturity. An account's funds are dated lots, oldest on the left. Past spends drained the two oldest lots, because spends draw oldest-first. The five newest lots are the live balance, the FIFO tail. A maturity horizon falls inside that tail: the three lots older than the horizon have matured and are cashable now; the two newest are still in their settlement wait. Cashable balance is the matured part of the tail."
      caption="Spends drain oldest-first, so the live balance is the newest run of lots. The cashable part is only the lots within that run that have passed their maturity horizon (now minus the settlement wait) — the tail read sums them newest-first and stops once it covers the balance."
    >
      <ArrowDefs />

      {/* tail bracket over the five newest lots */}
      <text className="d-elabel" x={(xs[2] + xs[6] + w) / 2} y={42} textAnchor="middle">
        live balance — newest lots, the FIFO tail
      </text>
      <path
        className="d-edge"
        d={`M${xs[2]},68 L${xs[2]},56 L${xs[6] + w},56 L${xs[6] + w},68`}
        fill="none"
      />

      {/* maturity horizon — its own band, clear of the tail label */}
      <text className="d-elabel" x={matLine} y={92} textAnchor="middle">
        maturity horizon
      </text>
      <line className="d-edge bad" x1={matLine} y1={100} x2={matLine} y2={172} />

      {/* lots */}
      <Pill x={xs[0]} y={116} w={w} h={42} variant="ghost" name="t1" />
      <Pill x={xs[1]} y={116} w={w} h={42} variant="ghost" name="t2" />
      <Pill x={xs[2]} y={116} w={w} h={42} variant="ok" name="t3" />
      <Pill x={xs[3]} y={116} w={w} h={42} variant="ok" name="t4" />
      <Pill x={xs[4]} y={116} w={w} h={42} variant="ok" name="t5" />
      <Pill x={xs[5]} y={116} w={w} h={42} name="t6" />
      <Pill x={xs[6]} y={116} w={w} h={42} name="t7" />

      {/* cashable bracket under the matured lots */}
      <path
        className="d-edge"
        d={`M${xs[2]},166 L${xs[2]},176 L${xs[4] + w},176 L${xs[4] + w},166`}
        fill="none"
      />
      <text className="d-name" x={(xs[2] + xs[4] + w) / 2} y={196} textAnchor="middle">
        cashable now — matured
      </text>

      <text className="d-sub" x={xs[0]} y={196} textAnchor="start">
        spent (drained first)
      </text>
      <text className="d-sub" x={xs[5] + 8} y={196} textAnchor="start">
        still clearing
      </text>

      {/* time axis */}
      <line
        className="d-edge"
        x1={xs[0]}
        y1={224}
        x2={xs[6] + w}
        y2={224}
        markerEnd="url(#dgm-arrow)"
      />
      <text className="d-sub" x={(xs[0] + xs[6] + w) / 2} y={242} textAnchor="middle">
        older lots → newer lots (spends drain the oldest first)
      </text>
    </Diagram>
  );
}

/**
 * The idempotency model: the first call with a key claims it, runs, and records its outcome under
 * the key; a retry with the same key finds it claimed and replays the recorded outcome without
 * re-running. Mirrors `idempotency` and `src/economy.ts` (runOnion).
 */
export function IdempotentRetry() {
  const col = { claim: 150, run: 290, record: 430, end: 570 };
  const w = 126;
  const y1 = 44;
  const y2 = 150;
  const mid = y1 + 22;
  const mid2 = y2 + 22;
  const recCx = col.record + w / 2;
  return (
    <Diagram
      viewBox="0 0 760 216"
      label="The idempotency model in two lanes. First call: claim the key — it is free, so the claim locks it — then run the handler by kind, record the outcome under the key, and return committed with its events. Retry with the same key: the claim finds the key already taken, so it skips the handler and replays the recorded outcome, returning duplicate. A dashed link shows the retry reusing the first call's recorded outcome."
      caption="The first call claims the key, runs, and records its outcome; a retry with the same key finds it claimed and replays the recorded outcome without re-running. A rejected or faulted request rolls back and leaves the key unused, so it can be retried under the same key — only a committed outcome consumes it."
    >
      <ArrowDefs />

      <text className="d-head" x={col.claim} y={30} textAnchor="start">
        FIRST CALL
      </text>
      <Pill x={col.claim} y={y1} w={w} variant="head" name="claim(key)" sub="free → lock" />
      <Pill x={col.run} y={y1} w={w} name="run handler" sub="by kind" />
      <Pill x={col.record} y={y1} w={w} name="record" sub="under the key" />
      <Pill x={col.end} y={y1} w={w} variant="ok" name="committed" sub="+ events" />
      <line
        className="d-edge"
        x1={col.claim + w}
        y1={mid}
        x2={col.run}
        y2={mid}
        markerEnd="url(#dgm-arrow)"
      />
      <line
        className="d-edge"
        x1={col.run + w}
        y1={mid}
        x2={col.record}
        y2={mid}
        markerEnd="url(#dgm-arrow)"
      />
      <line
        className="d-edge"
        x1={col.record + w}
        y1={mid}
        x2={col.end}
        y2={mid}
        markerEnd="url(#dgm-arrow)"
      />

      <text className="d-head" x={col.claim} y={136} textAnchor="start">
        RETRY, SAME KEY
      </text>
      <Pill x={col.claim} y={y2} w={w} variant="head" name="claim(key)" sub="already taken" />
      <Pill x={col.record} y={y2} w={w} name="replay" sub="recorded txn" />
      <Pill x={col.end} y={y2} w={w} name="duplicate" sub="no re-run" />
      <line
        className="d-edge"
        x1={col.claim + w}
        y1={mid2}
        x2={col.record}
        y2={mid2}
        markerEnd="url(#dgm-arrow)"
      />
      <line
        className="d-edge"
        x1={col.record + w}
        y1={mid2}
        x2={col.end}
        y2={mid2}
        markerEnd="url(#dgm-arrow)"
      />
      <text
        className="d-elabel"
        x={(col.claim + w + col.record) / 2}
        y={mid2 - 8}
        textAnchor="middle"
      >
        skip handler
      </text>

      {/* the recorded outcome is what the retry replays */}
      <line
        className="d-edge"
        strokeDasharray="4 3"
        x1={recCx}
        y1={y1 + 44}
        x2={recCx}
        y2={y2}
        markerEnd="url(#dgm-arrow)"
      />
      <text className="d-elabel" x={recCx + 8} y={(y1 + 44 + y2) / 2 + 4} textAnchor="start">
        reused
      </text>
    </Diagram>
  );
}
