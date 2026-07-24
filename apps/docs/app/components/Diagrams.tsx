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

import type { ReactNode } from 'react';

/**
 * In-document SVG diagrams for the concept pages, authored as components so each one is part of the
 * page DOM and themes from the same CSS variables as everything else — a `data-theme` toggle recolors
 * a diagram exactly as it recolors a Shiki code block. Each export is used in MDX with no import
 * (registered in `MDX_COMPONENTS`, see DocPage).
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

/** The fixed chart of accounts, with `spendable` backed one-for-one by `TRUST_CASH`; mirrors `src/accounts.ts`. */
export function ChartOfAccounts() {
  return (
    <Diagram
      viewBox="0 0 760 306"
      label="The chart of accounts. A user holds four CREDIT accounts: spendable (backed by trust cash), earned, promo, and per-session escrow (also backed, since escrow is custodial). The platform holds eleven house accounts: the USD accounts trust_cash, usd_clearing, and revenue_usd; and the CREDIT accounts stored_value, promo_float, receivable, revenue, payout_reserve, opening_equity, settlement_accrual, and netting_clearing. A user's spendable balance is backed one-for-one by trust_cash."
      caption="The fixed chart of accounts. A user's spendable credits — and the per-session escrow a prefunded fast lane parks them in — are backed one-for-one by USD in trust_cash; every other account is the platform's own cash, revenue, or a contra entry. settlement_accrual holds sellers' parked shares between charge and drain; netting_clearing is the pass-through a session's net settles across."
    >
      <ArrowDefs />

      <text className="d-head" x={135} y={22} textAnchor="middle">
        USER ACCOUNTS
      </text>
      <Acct x={40} y={40} w={190} name="spendable" note="CREDIT, backed by trust" />
      <Acct x={40} y={96} w={190} name="earned" note="CREDIT, owed to seller" />
      <Acct x={40} y={152} w={190} name="promo" note="CREDIT, expires if unspent" />
      <Acct x={40} y={208} w={190} name="escrow" note="CREDIT, per session, backed" />

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
      <Acct x={320} y={208} w={200} name="SETTLEMENT_ACCRUAL" note="CREDIT, parked shares" />
      <Acct x={534} y={208} w={200} name="NETTING_CLEARING" note="CREDIT, settle pass-through" />

      {/* the backing edge — the solvency invariant */}
      <line className="d-edge" x1={230} y1={62} x2={316} y2={62} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={273} y={52} textAnchor="middle">
        backed
      </text>
      <text className="d-elabel" x={273} y={78} textAnchor="middle">
        one-for-one
      </text>

      <rect className="d-box usd" x={40} y={270} width={16} height={12} rx={2} />
      <text className="d-sub" x={62} y={280}>
        USD account
      </text>
      <rect className="d-box" x={170} y={270} width={16} height={12} rx={2} />
      <text className="d-sub" x={192} y={280}>
        CREDIT account
      </text>
    </Diagram>
  );
}

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

/** The payout saga state machine; mirrors the payout-saga page and `src/worker/payouts.ts`. */
export function PayoutSaga() {
  return (
    <Diagram
      viewBox="0 0 760 250"
      label="The payout saga state machine. A live payout starts RESERVED. The payouts sweep submits the saga's stored USD quote to the rail and advances it to SUBMITTED. The provider's settlement webhook advances SUBMITTED to SETTLED, a terminal state. From RESERVED or SUBMITTED a timeout, exhausted attempts, or an operator reversal force-fail the saga to FAILED, returning the reserve to the seller's earned account. SagaState also declares REQUESTED, but a live payout opens already RESERVED."
      caption="The payout saga. Each transition is a compare-and-set, and the transitions that move money post it in the same transaction, so a re-driven step pays at most once. SETTLED and FAILED are terminal; the reserve is released exactly once."
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
        submits USD quote
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
        d="M136,92 C136,150 250,150 310,168"
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

/** The subscription state machine; mirrors the subscriptions page and `src/worker/subscriptions.ts`. */
export function SubscriptionStates() {
  return (
    <Diagram
      viewBox="0 0 760 250"
      label="The subscription state machine. A subscription starts ACTIVE and renews in place each period; a successful renewal resets its failure count. When a charge cannot succeed — unaffordable, a permanent billing failure, or the attempt cap — the sweep moves it to LAPSED, revoking the SKU entitlement in the same step. The user or an operator can move it to CANCELED at any time; the current period is not refunded. LAPSED and CANCELED are terminal."
      caption="A subscription only moves forward: it renews in place until a charge that will never succeed lapses it or a cancel ends it. Both ends are terminal, and a lapse revokes the SKU entitlement in the same transaction."
    >
      <ArrowDefs />

      <State x={70} y={88} name="ACTIVE" sub="renews each period" />
      <State x={520} y={36} name="LAPSED" sub="terminal" variant="bad" />
      <State x={520} y={158} name="CANCELED" sub="terminal" />

      {/* successful renewal loops in place */}
      <path
        className="d-edge"
        d="M104,84 C84,34 188,34 168,84"
        fill="none"
        markerEnd="url(#dgm-arrow)"
      />
      <text className="d-elabel" x={136} y={30} textAnchor="middle">
        renewal succeeds — count resets
      </text>

      {/* involuntary exit */}
      <line className="d-edge bad" x1={202} y1={100} x2={516} y2={62} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={359} y={44} textAnchor="middle">
        charges fail — cap or permanent
      </text>
      <text className="d-elabel" x={359} y={60} textAnchor="middle">
        → entitlement revoked, same step
      </text>

      {/* voluntary exit */}
      <line className="d-edge" x1={202} y1={122} x2={516} y2={176} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={359} y={196} textAnchor="middle">
        user or operator cancels
      </text>
      <text className="d-elabel" x={359} y={212} textAnchor="middle">
        → current period not refunded
      </text>

      <text className="d-note" x={70} y={232}>
        Renewals draw only from spendable; the first period may draw on promo credit.
      </text>
    </Diagram>
  );
}

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

/** The integrity construction, per-account hash chains folding into one signed Merkle checkpoint; mirrors the integrity page and `src/chain.ts`. */
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
        each link = hash(account's legs + metadata + prior head); the first starts from genesis (64
        zeros)
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

/** The dual-rate ladder, `buy` above `par` with the gap as the platform spread; mirrors the money-model page and the `Rates` port. */
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

/** The submit pipeline from validation through the committed outcome; mirrors the-economy page and `src/economy.ts`. */
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

/** The life of one outbox row; mirrors the messaging page and `src/worker/relay.ts`. */
export function OutboxRelay() {
  return (
    <Diagram
      viewBox="0 0 760 250"
      label="The outbox row lifecycle. A row is written PENDING in the same database transaction as the money move it announces. The relay sweep sends it through the Dispatcher and marks it RELAYED, a terminal state. A send that throws leaves the row pending with its attempt count bumped, retried on the next run; when attempts hit the configured cap the row is dead-lettered to the terminal DEAD state, so one poison event cannot wedge the queue behind it."
      caption="One outbox row. The write shares the posting's transaction, so an event is never sent for a rolled-back move nor lost for a committed one. Delivery is at-least-once: the far side dedupes by event id."
    >
      <ArrowDefs />

      <State x={70} y={48} name="PENDING" sub="written with the commit" />
      <State x={558} y={48} name="RELAYED" sub="terminal" variant="ok" />
      <State x={314} y={158} name="DEAD" sub="terminal" variant="bad" />

      {/* forward path */}
      <line className="d-edge" x1={202} y1={70} x2={554} y2={70} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={378} y={56} textAnchor="middle">
        relay sweep
      </text>
      <text className="d-elabel" x={378} y={92} textAnchor="middle">
        through the dispatcher
      </text>

      {/* retry loop: a failed send stays pending */}
      <path
        className="d-edge"
        d="M104,48 C104,14 168,14 168,44"
        fill="none"
        markerEnd="url(#dgm-arrow)"
      />
      <text className="d-elabel" x={210} y={24} textAnchor="start">
        send threw: stays pending, attempts + 1
      </text>

      {/* dead-letter branch */}
      <path
        className="d-edge bad"
        d="M136,92 C136,150 240,150 310,176"
        fill="none"
        markerEnd="url(#dgm-arrow)"
      />
      <text className="d-elabel" x={470} y={172} textAnchor="start">
        attempts hit the cap — dead-lettered,
      </text>
      <text className="d-elabel" x={470} y={188} textAnchor="start">
        the queue never wedges behind it
      </text>

      <text className="d-note" x={70} y={232}>
        The inbox mirrors this shape for events coming in: recorded with the webhook ingress,
        applied or dead-lettered by its own sweep.
      </text>
    </Diagram>
  );
}

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

/** Credit maturity, dated lots draining oldest-first with the matured tail a cash-out may draw; mirrors `src/maturity.ts`. */
export function CreditMaturity() {
  const xs = [30, 124, 218, 312, 406, 500, 594];
  const w = 84;
  const matLine = 495; // between the matured tail and the still-clearing tail
  return (
    <Diagram
      viewBox="0 0 760 262"
      label="Credit maturity. An account's funds are dated lots, oldest on the left. Past spends drained the two oldest lots, because spends draw oldest-first. The five newest lots are the live balance, the FIFO tail. A maturity horizon falls inside that tail: the three lots older than the horizon have matured; the two newest are still in their settlement wait. The matured balance is the cleared part of the tail."
      caption="Spends drain oldest-first, so the live balance is the newest run of lots. The matured part is only the lots within that run that have passed their maturity horizon (now minus the settlement wait) — the tail read sums them newest-first and stops once it covers the balance."
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

      {/* matured bracket under the cleared lots */}
      <path
        className="d-edge"
        d={`M${xs[2]},166 L${xs[2]},176 L${xs[4] + w},176 L${xs[4] + w},166`}
        fill="none"
      />
      <text className="d-name" x={(xs[2] + xs[4] + w) / 2} y={196} textAnchor="middle">
        matured — spendable and payable
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

/** The idempotency model, a first call claiming the key and a retry replaying the recorded outcome; mirrors the idempotency page and `src/economy.ts` (runClaimed). */
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

/** A netting session: movements journal in batches, and settle folds the journal into one net posting; mirrors the session-netting page and `src/netting.ts`. */
export function SessionNetting() {
  return (
    <Diagram
      viewBox="0 0 760 262"
      label="One netting session. Three movements arrive — record screens each against the reservation registry and appends the accepted ones to the session journal, whose rows are hash-chained: a genesis value, then links through the current head. Settle derives the net from the journal, verifies the chain, and posts the net to the ledger in clearing chunks through the netting_clearing account; each chunk's posting anchors the journal's final head."
      caption="The journal is the source of truth, never session memory. Settle reads the journal back, verifies its chain, and posts the net in clearing chunks — and because each chunk's posting anchors the final head, tamper-evidence runs from the proved ledger down to every movement."
    >
      <ArrowDefs />

      <text className="d-head" x={30} y={22} textAnchor="start">
        MOVEMENTS
      </text>
      <Pill x={30} y={34} w={148} name="record" sub="buyer → seller · 300.00" />
      <Pill x={30} y={90} w={148} name="record" sub="buyer → seller · 120.00" />
      <Pill x={30} y={146} w={148} name="record" sub="rejected: insufficient funds" variant="bad" />

      {/* accepted movements append to the journal */}
      <line className="d-edge" x1={178} y1={56} x2={268} y2={88} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge" x1={178} y1={112} x2={268} y2={98} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={222} y={52} textAnchor="middle">
        journal batch
      </text>

      <text className="d-head" x={272} y={64} textAnchor="start">
        SESSION JOURNAL
      </text>
      <Link x={272} y={78} text="0000…" variant="genesis" />
      <Link x={362} y={78} text="b4c9…" />
      <Link x={452} y={78} text="d21e…" variant="head" />
      <line className="d-edge" x1={342} y1={93} x2={358} y2={93} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge" x1={432} y1={93} x2={448} y2={93} markerEnd="url(#dgm-arrow)" />
      <text className="d-note" x={272} y={136}>
        rows hash-chained per session
      </text>

      {/* settle folds the journal into the net postings */}
      <line className="d-edge" x1={522} y1={93} x2={574} y2={93} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={550} y={80} textAnchor="middle">
        settle
      </text>

      <Pill x={578} y={71} w={152} name="net postings" sub="via NETTING_CLEARING" variant="head" />

      <line className="d-edge" x1={654} y1={115} x2={654} y2={158} markerEnd="url(#dgm-arrow)" />
      <Pill x={578} y={162} w={152} name="ledger" sub="anchors the final head" variant="ok" />

      <text className="d-note" x={30} y={232}>
        A session settles once: record on a settled session throws SESSION.SETTLED; a long-lived
        scope rotates epochs instead.
      </text>
    </Diagram>
  );
}

/** The accrual split: a charge parks the seller's share, the drain sweep settles it; mirrors the accrual-split page, `src/operations/accrual.ts`, and `src/worker/accrual.ts`. */
export function AccrualSplit() {
  return (
    <Diagram
      viewBox="0 0 760 250"
      label="The accrual split. A charge that would credit the seller's earned account redirects that leg to a settlement_accrual shard and records an accrual row naming the seller and amount. The worker's accrualDrain sweep later claims the pending rows and credits the seller's earned account once for their sum — one posting per seller per run. A refund claims the order's own rows and claws a pending share back out of the exact shard that holds it."
      caption="The charge and the seller's credit decouple: buyers stop serializing on a hot seller's row, and the accrual rows carry every share from charge to drain. A refund follows the rows, so the path holds even for a sale parked before the flag was turned off."
    >
      <ArrowDefs />

      <Pill x={30} y={48} w={148} name="charge" sub="spend · subscribe" />
      <Pill x={306} y={48} w={168} name="SETTLEMENT_ACCRUAL" sub="shard, parked shares" />
      <Pill x={582} y={48} w={148} name="earned" sub="the seller's row" variant="ok" />

      {/* park */}
      <line className="d-edge" x1={178} y1={70} x2={302} y2={70} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={240} y={56} textAnchor="middle">
        parks the share
      </text>
      <text className="d-elabel" x={240} y={104} textAnchor="middle">
        + one accrual row per seller
      </text>

      {/* drain */}
      <line className="d-edge" x1={474} y1={70} x2={578} y2={70} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={526} y={56} textAnchor="middle">
        drain sweep
      </text>
      <text className="d-elabel" x={526} y={104} textAnchor="middle">
        one posting per seller
      </text>

      {/* refund claws back pending rows */}
      <path
        className="d-edge bad"
        d="M330,92 C300,150 180,150 120,96"
        fill="none"
        markerEnd="url(#dgm-arrow)"
      />
      <text className="d-elabel" x={160} y={152} textAnchor="start">
        refund claims the order's rows —
      </text>
      <text className="d-elabel" x={160} y={168} textAnchor="start">
        pending shares claw back from their shard
      </text>

      <text className="d-note" x={30} y={218}>
        Rows are never deleted: pending becomes drained or refunded, so the trail from every sale to
        every settlement stays whole.
      </text>
      <text className="d-note" x={30} y={232}>
        Refund recoveries net first, repaying RECEIVABLE.
      </text>
    </Diagram>
  );
}

/** One hot platform account split into shard rows, routed by idempotency key, summed by readers; mirrors the platform-sharding page and `src/accounts.ts`. */
export function PlatformShards() {
  const ops = [
    ['spend', 'idem key a7f2…', 76],
    ['spend', 'idem key 03bc…', 20],
    ['topUp', 'idem key e419…', 188],
  ] as const;
  const rows = [20, 76, 132, 188];
  const shardNames = [
    'platform:revenue',
    'platform:revenue#1',
    'platform:revenue#2',
    'platform:revenue#3',
  ];
  return (
    <Diagram
      viewBox="0 0 760 268"
      label="Platform sharding. Three concurrent operations — two spends and a top-up — each hash their idempotency key to pick a shard row of the platform revenue account: platform:revenue (shard 0, the bare id) plus #1 through #3. The operations land on different rows, so they take different locks instead of queueing on one. On the right, a reader sums the four rows into one logical balance."
      caption="Concurrent postings spread across the shard rows instead of queueing on one lock. The routing hashes the operation's idempotency key, so a retry lands on the row the first attempt locked — and no reader cares which row holds what: the logical balance is the sum."
    >
      <ArrowDefs />

      <text className="d-head" x={30} y={12} textAnchor="start">
        OPERATIONS
      </text>
      {ops.map(([name, sub, target], i) => (
        <g key={sub}>
          <Pill x={30} y={20 + i * 56} w={140} name={name} sub={sub} />
          <line
            className="d-edge"
            x1={170}
            y1={42 + i * 56}
            x2={356}
            y2={target + 22}
            markerEnd="url(#dgm-arrow)"
          />
        </g>
      ))}
      <text className="d-elabel" x={263} y={158} textAnchor="middle">
        shard = hash(idempotency key)
      </text>

      <text className="d-head" x={360} y={12} textAnchor="start">
        SHARD ROWS
      </text>
      {shardNames.map((name, i) => (
        <g key={name}>
          <Pill
            x={360}
            y={rows[i]}
            w={190}
            name={name}
            sub={i === 0 ? 'shard 0 — the bare id' : 'its own lock and chain'}
          />
          <line
            className="d-edge"
            x1={550}
            y1={rows[i] + 22}
            x2={606}
            y2={126}
            markerEnd="url(#dgm-arrow)"
          />
        </g>
      ))}

      <Pill x={610} y={104} w={120} name="one balance" sub="readers sum" variant="ok" />

      <text className="d-note" x={30} y={244}>
        Shard 0 keeps the bare id, so an existing ledger's balances already sit on it and turning
        sharding on later is safe.
      </text>
      <text className="d-note" x={30} y={258}>
        PAYOUT_RESERVE routes by user id instead — both ends of a payout know it.
      </text>
    </Diagram>
  );
}

/** The deadlock two lock orders produce and the one a global sort prevents; mirrors the concurrency page and `src/ledger.ts` lockAll. */
export function LockOrdering() {
  return (
    <Diagram
      viewBox="0 0 760 280"
      label="Two transactions locking accounts A and B. Left, arbitrary order: transaction 1 holds A and waits for B while transaction 2 holds B and waits for A — a circular wait, deadlock. Right, one global order: both transactions acquire A first, then B; transaction 2 simply waits its turn at A and proceeds when transaction 1 commits. Below, the database backstop: a unique index on (account id, previous hash) refuses a second posting at the same chain head."
      caption="A shared total order — a plain sort of the account ids — removes the circular wait: both takers acquire A before B, so one waits and neither deadlocks. Beneath the locks, the unique index on (account_id, prev_hash) refuses a forked chain head outright; the loser retries against the new head."
    >
      <ArrowDefs />

      <text className="d-head" x={30} y={22} textAnchor="start">
        ARBITRARY ORDER
      </text>
      <Pill x={30} y={44} w={110} name="txn 1" sub="holds A" />
      <Pill x={30} y={144} w={110} name="txn 2" sub="holds B" />
      <Pill x={230} y={44} w={90} name="A" />
      <Pill x={230} y={144} w={90} name="B" />
      <line className="d-edge" x1={140} y1={66} x2={226} y2={66} />
      <line className="d-edge" x1={140} y1={166} x2={226} y2={166} />
      <line className="d-edge bad" x1={140} y1={80} x2={226} y2={156} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge bad" x1={140} y1={152} x2={226} y2={76} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={183} y={178} textAnchor="middle">
        each waits
      </text>
      <text className="d-elabel" x={183} y={244} textAnchor="middle">
        circular wait — deadlock
      </text>

      <text className="d-head" x={430} y={22} textAnchor="start">
        ONE GLOBAL ORDER
      </text>
      <Pill x={430} y={44} w={110} name="txn 1" sub="A, then B" />
      <Pill x={430} y={144} w={110} name="txn 2" sub="A, then B" />
      <Pill x={630} y={44} w={90} name="A" />
      <Pill x={630} y={144} w={90} name="B" />
      <line className="d-edge" x1={540} y1={66} x2={626} y2={66} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge" x1={675} y1={88} x2={675} y2={140} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge" x1={540} y1={158} x2={626} y2={80} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={452} y={122} textAnchor="start">
        waits its turn at A
      </text>
      <text className="d-elabel" x={583} y={244} textAnchor="middle">
        both acquire A before B — no cycle
      </text>

      <text className="d-note" x={30} y={272}>
        The database backstop below the locks: the unique index on (account_id, prev_hash) refuses a
        forked chain head; the loser retries.
      </text>
    </Diagram>
  );
}

/** The shape of the whole system: submit commits the posting and its event together, the worker runs off-path; mirrors the overview page and `src/economy.ts`. */
export function SystemShape() {
  return (
    <Diagram
      viewBox="0 0 760 300"
      label="The shape of the system. Your service calls submit, which validates and authorizes, then commits inside one transaction: a balanced posting to the append-only hash-chained ledger and the matching event to the outbox, together or not at all. Reads fold balances back from the postings. Off the request path, the background worker drains the outbox to the dispatcher and runs the recurring sweeps; verified provider webhooks enter through the inbox and apply through the same submit."
      caption="One synchronous path and one deferred path. A submit commits its posting and its event in one transaction, reads fold from the postings, and everything that outlives a request — relaying events, payouts, renewals, checkpoints — runs on the worker, off the request path."
    >
      <ArrowDefs />

      <Pill x={30} y={80} w={140} name="your service" sub="submit · read" />

      <Pill x={240} y={80} w={130} name="submit" sub="validate · authorize" />
      <line className="d-edge" x1={170} y1={102} x2={236} y2={102} markerEnd="url(#dgm-arrow)" />

      <rect className="d-box ghost" x={420} y={40} width={310} height={150} rx={8} />
      <text className="d-head" x={575} y={60} textAnchor="middle">
        ONE TRANSACTION
      </text>
      <Pill x={440} y={72} w={270} name="ledger" sub="append-only · hash-chained" />
      <Pill x={440} y={132} w={270} name="outbox" sub="the matching event" />
      <line className="d-edge" x1={370} y1={102} x2={436} y2={102} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={403} y={88} textAnchor="middle">
        post
      </text>

      {/* the read path folds from postings */}
      <path
        className="d-edge"
        strokeDasharray="4 3"
        d="M100,80 C100,20 440,20 500,68"
        fill="none"
        markerEnd="url(#dgm-arrow)"
      />
      <text className="d-elabel" x={280} y={32} textAnchor="middle">
        read — balances fold from the postings
      </text>

      {/* the worker, off the request path */}
      <Pill x={240} y={230} w={130} name="worker" sub="off the request path" />
      <line
        className="d-edge"
        strokeDasharray="4 3"
        x1={305}
        y1={226}
        x2={305}
        y2={128}
        markerEnd="url(#dgm-arrow)"
      />
      <text className="d-elabel" x={313} y={180} textAnchor="start">
        applies inbound
      </text>
      <line className="d-edge" x1={370} y1={244} x2={480} y2={180} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={442} y={232} textAnchor="start">
        drains the outbox, runs the sweeps
      </text>

      <Pill x={30} y={230} w={140} name="webhooks" sub="verified inbound" />
      <line className="d-edge" x1={170} y1={252} x2={236} y2={252} markerEnd="url(#dgm-arrow)" />
      <text className="d-note" x={30} y={292}>
        A verified provider callback lands in the inbox and applies through the same submit a direct
        caller hits.
      </text>
    </Diagram>
  );
}

/** The fast lane's two tracks: ownership durable at purchase, money settling at epoch end; mirrors the instance-economy page and `src/instance.ts`. */
export function InstanceLane() {
  return (
    <Diagram
      viewBox="0 0 760 260"
      label="The instance economy's two tracks over one epoch. On the ownership track, a purchase accepted at time zero writes the grant through to the entitlement store immediately — every reader sees it from that moment. On the money track, the same purchase appends to the hash-chained session journal, and at epoch end one settle folds the journal into a single net posting on the ledger. One backward arrow shows the backstop: a movement the settle replay refuses takes its grant with it, listed in the report's revoked entries."
      caption="Ownership is durable immediately; the ledger money is settle-deferred. The journal — not lane memory — is what settle replays, so a crash between purchase and settle loses nothing, and a movement the replay refuses revokes exactly its own grant."
    >
      <ArrowDefs />

      <text className="d-head" x={30} y={22} textAnchor="start">
        OWNERSHIP
      </text>
      <Pill x={30} y={34} w={130} name="purchase" sub="accepted at t₀" />
      <Pill x={220} y={34} w={170} name="grant durable" sub="entitlement store" variant="ok" />
      <line className="d-edge" x1={160} y1={56} x2={216} y2={56} markerEnd="url(#dgm-arrow)" />
      <line
        className="d-edge"
        strokeDasharray="4 3"
        x1={390}
        y1={56}
        x2={726}
        y2={56}
        markerEnd="url(#dgm-arrow)"
      />
      <text className="d-elabel" x={558} y={44} textAnchor="middle">
        every reader sees it from t₀
      </text>

      <text className="d-head" x={30} y={116} textAnchor="start">
        MONEY
      </text>
      <Link x={220} y={128} text="0000…" variant="genesis" />
      <Link x={310} y={128} text="b4c9…" />
      <Link x={400} y={128} text="d21e…" variant="head" />
      <line className="d-edge" x1={290} y1={143} x2={306} y2={143} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge" x1={380} y1={143} x2={396} y2={143} markerEnd="url(#dgm-arrow)" />
      <line className="d-edge" x1={95} y1={78} x2={230} y2={126} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={118} y={112} textAnchor="start">
        journals
      </text>
      <line className="d-edge" x1={470} y1={143} x2={546} y2={143} markerEnd="url(#dgm-arrow)" />
      <text className="d-elabel" x={510} y={130} textAnchor="middle">
        settle
      </text>
      <Pill
        x={550}
        y={121}
        w={180}
        name="one net posting"
        sub="on the ledger, at epoch end"
        variant="head"
      />

      {/* the backstop */}
      <path
        className="d-edge bad"
        d="M596,121 C516,84 420,80 394,76"
        fill="none"
        markerEnd="url(#dgm-arrow)"
      />
      <text className="d-elabel" x={452} y={72} textAnchor="start">
        replay refused → revoked
      </text>

      {/* the time axis */}
      <line className="d-edge" x1={30} y1={210} x2={730} y2={210} markerEnd="url(#dgm-arrow)" />
      <text className="d-sub" x={95} y={228} textAnchor="middle">
        t₀ — purchase
      </text>
      <text className="d-sub" x={640} y={228} textAnchor="middle">
        epoch end (≤ 60 s default)
      </text>
      <text className="d-note" x={30} y={252}>
        The epoch rotates by movements or age; a settle that throws keeps its lane and retries.
      </text>
    </Diagram>
  );
}
