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

import {
  createReservations,
  epochMinter,
  openInstanceSession,
  refundEscrowRemainder,
} from '#src/netting.ts';

import type { Reservations } from '#src/netting.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { maturedBalance } from '#src/maturity.ts';
import { sessionEscrow, spendable } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import { pendingOutbox } from '#src/outbox.ts';
import { EVENT_VERSION } from '#src/ports.ts';
import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';
import { intervalScheduler } from '#src/runtime.ts';
import { assertRecipientShares } from '#src/operations/guards.ts';
import { saleSource } from '#src/entitlements.ts';
import { hasWireShape } from '#src/wire-contract.ts';
import type { Spec } from '#src/wire-contract.ts';

import type {
  InstanceSession,
  SessionOptions,
  SettleReport,
} from '#src/netting.ts';
import type { ErrorCode, RejectionCode } from '#src/errors.ts';
import type { Amount } from '#src/money.ts';
import { checkedConfig } from '#src/config.ts';

import type { CheckedConfig, Config } from '#src/config.ts';
import type { FeePolicy, Recipient } from '#src/contract.ts';
import type {
  Clock,
  Digest,
  EconomyEvent,
  Ids,
  Leg,
  Logger,
  Meter,
  Scheduler,
  Store,
} from '#src/ports.ts';

/** What the instance economy needs from Ports — a structural subset, so an openPorts host passes straight through. */
export type InstanceEconomyDeps = {
  store: Store;
  digest: Digest;
  clock: Clock;
  ids: Ids;
  pricing: FeePolicy;
  config: Config;
  logger?: Logger;
  meter?: Meter;
  /** Drives the manager's `start` loop. When absent, a built-in interval timer stands in. */
  scheduler?: Scheduler;
};

/**
 * `permanent` and `temporary` grant durable ownership immediately; `instant` is consumable
 * and grants nothing.
 */
export type ProductKind = 'permanent' | 'temporary' | 'instant';

/**
 * One purchase offered to the lane. The economy service builds this from its own catalog and
 * routing, so a malformed shape (non-CREDIT price, unknown kind, shares off 10000 bps) throws a
 * fault rather than rejecting. A bad shape is a wiring bug, not a buyer outcome.
 */
export type InstancePurchase = {
  buyerId: string;

  /** The full CREDIT price. Drawn from spendable only (promo is main-lane). */
  price: Amount;

  /** Sale split, spend's rule: shares of the post-fee net, summing to exactly 10000 bps. */
  recipients: ReadonlyArray<Recipient>;

  product: {
    sku: string;
    kind: ProductKind;
    /** Epoch ms a `temporary` grant lapses. Required for temporary, forbidden otherwise. */
    expiresAt?: number;
  };

  /**
   * Defaults to `<sessionId>:<n>`. A caller-supplied id must carry the session prefix —
   * session orders never collide with main-lane orderIds, by construction.
   */
  orderId?: string;
};

/**
 * What `purchase` resolves to. Accepted means granted and journaled, with `seq` its session
 * sequence. The money turns ledger-final only at settle. A repeat of a seen orderId replays
 * this recorded outcome without re-running side effects.
 */
export type PurchaseOutcome =
  | { status: 'accepted'; orderId: string; seq: number }
  | { status: 'rejected'; orderId: string; reason: RejectionCode | ErrorCode };

/**
 * The session's {@link SettleReport} plus the lane's cross-lane backstop, `revoked`. A movement
 * the settle replay refused moved no money, so the ownership its grant handed out is withdrawn.
 */
export type InstanceSettleReport = SettleReport & {
  /** Grants revoked because the settle replay refused their movement (the cross-lane backstop). */
  revoked: ReadonlyArray<{ buyerId: string; sku: string; orderId: string }>;
};

/**
 * The lane's knobs cover the session's batch bounds and shared registry, the per-buyer spend
 * cap, and the prefund escrow opt-in.
 */
export type InstanceEconomyOptions = Pick<
  SessionOptions,
  'maxBatch' | 'chunkWidth' | 'reservations'
> & {
  /**
   * Ceiling (CREDIT minor units) one buyer may spend in this session. Bounds the velocity/risk
   * exposure the fast lane forgoes, and what one buyer can commit across nodes before the
   * shared reservation counter converges. Production configs set it.
   */
  perUserCapMinor?: bigint;

  /**
   * Prefund mode (host opt-in): each buyer's first purchase moves `amountMinor` of matured
   * spendable credits into a per-(user, session) escrow account by a real ledger posting.
   * Every movement in this lane then debits that escrow instead of `spendable`. The account key
   * is the crash-safe attribution: recovery derives the unspent remainder from durable postings
   * plus the journal. The accept screen becomes session-local, because the escrow belongs to
   * this session alone. That is what removes the cross-node contention on the buyer's
   * spendable. Settle refunds the remainder to `spendable`. The orphan sweep repairs a crashed
   * refund.
   */
  prefund?: { amountMinor: bigint };
};

/**
 * Opens the fast lane over one netting session. A purchase grants ownership now, by a durable
 * entitlement write every reader sees, while its money rides the journal and nets to the
 * ledger at epoch-end settle.
 *
 * The session's lifecycle rules apply: settle once per session id, rotate epochs
 * (`sess:<scope>:<n>`) for cadence, share one reservations registry per process. Most hosts
 * open lanes through {@link openInstanceEconomies}, which owns those rules.
 *
 * @example
 * const lane = openInstanceEconomy(ports, `sess:${worldInstanceId}:0`, { // epoch 0 of this scope
 *   reservations, // optional: the process-wide registry (a private one guards this lane alone)
 *   maxBatch: 64, // optional: accepted movements per journal batch
 *   chunkWidth: 16, // optional: max participant accounts per settlement chunk
 *   perUserCapMinor: 500_000n, // optional: one buyer's epoch ceiling (5,000 credits)
 *   prefund: { amountMinor: 120_000n }, // optional: escrow 1,200 credits per buyer up front
 * });
 */
export function openInstanceEconomy(
  deps: InstanceEconomyDeps,
  sessionId: string,
  options: InstanceEconomyOptions = {},
): InstanceEconomy {
  return new InstanceEconomy(deps, sessionId, options);
}

type GrantedOrder = { buyerId: string; sku: string };

const PRODUCT_KINDS: ReadonlySet<string> = new Set([
  'permanent',
  'temporary',
  'instant',
]);

// The prefix every order id in this session carries. Session ids are minted `sess:<scope>:<n>`,
// so the marker is already there; a scope id opened without one gets it, and never twice.
function sessionOrderPrefix(sessionId: string): string {
  return sessionId.startsWith('sess:') ? `${sessionId}:` : `sess:${sessionId}:`;
}

/**
 * One epoch's lane over one netting session. `purchase` grants now and defers the money.
 *
 * `settle` nets the epoch to the ledger and applies the backstops: grants whose movement the
 * settle replay refused are revoked (the report's `revoked` list), immature holds release, and
 * prefund escrows refund their remainder to spendable.
 *
 * Every entry point rides one internal writer queue; concurrent calls from an HTTP edge
 * serialize instead of forking the session chain.
 *
 * Construct through {@link openInstanceEconomy}, or {@link InstanceEconomies.laneFor}.
 */
export class InstanceEconomy {
  private readonly deps: InstanceEconomyDeps;
  // InstanceEconomyDeps.config is a structural field of a published bag, so the lane checks it
  // here and reads this field rather than deps.config: the fee below cannot come from a knob the
  // bounds never saw.
  private readonly config: CheckedConfig;
  private readonly sessionId: string;
  private readonly session: InstanceSession;
  private readonly capMinor: bigint | null;

  private orderSeq = 0;
  private accepted = 0;
  private rejected = 0;
  // The lane is single-writer: purchases, flushes, and settles ride this one promise chain (the
  // memory store's writer-queue pattern). The HTTP edge serves concurrent requests per scope.
  // Without the queue, two in-flight purchases could interleave mid-await and fork the session
  // chain on one seq, or double-hold a buyer's immature slice in the shared registry.
  private tail: Promise<unknown> = Promise.resolve();
  private settleReport: SettleReport | null = null;
  private settledEmitted = false;
  private readonly prefund: { amountMinor: bigint } | null;
  // Buyers whose escrow this lane already funded (or found funded on a replayed epoch).
  private readonly funded = new Set<string>();
  // The wrapper replays outcomes by orderId here. The session already replays the movement, but
  // the wrapper's own side effects (grant upsert, cap accounting, spend totals) must not run
  // twice.
  private readonly outcomes = new Map<string, PurchaseOutcome>();
  private readonly spent = new Map<string, bigint>();
  // Accepted grant-carrying orders, so a settle-replay rejection can revoke exactly its own.
  private readonly granted = new Map<string, GrantedOrder>();
  // The immature slice of each buyer's balance, parked in the shared registry at first touch so
  // the session's affordability screen only ever sees matured funds. The hold releases after
  // settle.
  private readonly immatureHeld = new Map<string, bigint>();
  private readonly reservations: NonNullable<SessionOptions['reservations']>;

  constructor(
    deps: InstanceEconomyDeps,
    sessionId: string,
    options: InstanceEconomyOptions,
  ) {
    this.deps = deps;
    this.config = checkedConfig(deps.config);
    this.sessionId = sessionId;
    this.capMinor = options.perUserCapMinor ?? null;
    this.prefund = options.prefund ?? null;
    // One registry shared between this wrapper (holds, pending) and the session (screen). This
    // is the caller's process-wide registry when given, a private one otherwise.
    this.reservations = options.reservations ?? createReservations();
    const sessionOptions: SessionOptions = {
      ...(options.maxBatch === undefined ? {} : { maxBatch: options.maxBatch }),
      ...(options.chunkWidth === undefined
        ? {}
        : { chunkWidth: options.chunkWidth }),
      reservations: this.reservations,
    };
    this.session = openInstanceSession(deps, sessionId, sessionOptions);
  }

  /**
   * One in-world purchase, grant-now-settle-later.
   *
   * The entitlement grant is durable before the movement is offered to the session:
   * ownership reads true everywhere immediately while the money waits for epoch-end settle.
   * The worst crash leaves one owned-but-unpaid item, reconcilable by its `sale:<orderId>`
   * source — never lost money.
   *
   * Malformed input throws. The expected refusals come back rejected: INSUFFICIENT_FUNDS
   * against matured balance minus everything pending (or a failed prefund), and RISK_DENIED
   * over `perUserCapMinor`. A rejection leaves no grant behind.
   *
   * Idempotent per orderId: a repeat replays the recorded outcome.
   */
  purchase(input: InstancePurchase): Promise<PurchaseOutcome> {
    return this.serialize(() => this.runPurchase(input));
  }

  private async runPurchase(input: InstancePurchase): Promise<PurchaseOutcome> {
    this.validate(input);
    const orderId = this.orderIdOf(input);
    const replay = this.outcomes.get(orderId);
    if (replay !== undefined) {
      return replay;
    }
    const buyer = input.buyerId;

    if (this.prefund === null) {
      await this.holdImmature(buyer);
    } else if (!(await this.ensurePrefunded(buyer))) {
      this.rejected += 1;
      return this.metered(input, {
        status: 'rejected',
        orderId,
        reason: 'INSUFFICIENT_FUNDS',
      });
    }
    const capped = this.overCap(buyer, input.price.minor);
    if (capped) {
      this.rejected += 1;
      return this.metered(input, {
        status: 'rejected',
        orderId,
        reason: 'RISK_DENIED',
      });
    }

    // Ownership goes first, at global visibility, for the grant-carrying kinds — the one
    // statement on this path. Grant-then-record ordering means the worst crash leaves one
    // owned-but-unpaid item, reconcilable by its `sale:<orderId>` source against the journal.
    // Money is never lost.
    const grants = input.product.kind !== 'instant';
    if (grants) {
      await this.deps.store.entitlements.grant(buyer, input.product.sku, {
        source: saleSource(orderId),
        ...(input.product.kind === 'temporary'
          ? { expiresAt: input.product.expiresAt! }
          : {}),
      });
    }

    const outcome = await this.session.record({
      idempotencyKey: orderId,
      legs: this.legsOf(input),
    });
    if (outcome.status === 'rejected') {
      if (grants) {
        await this.deps.store.entitlements.revoke(buyer, input.product.sku, {
          source: saleSource(orderId),
        });
      }
      this.rejected += 1;
      return this.metered(input, {
        status: 'rejected',
        orderId,
        reason: outcome.reason,
      });
    }

    if (grants) {
      this.granted.set(orderId, { buyerId: buyer, sku: input.product.sku });
    }
    this.accepted += 1;
    this.spent.set(buyer, (this.spent.get(buyer) ?? 0n) + input.price.minor);
    return this.metered(input, {
      status: 'accepted',
      orderId,
      seq: outcome.seq,
    });
  }

  /** This tier's pending-out total for the user, for display as `balance - pending`. */
  async pending(userId: string): Promise<Amount> {
    const natural = await this.reservations.pending(spendable(userId));
    return toAmount('CREDIT', natural < 0n ? -natural : 0n);
  }

  /** Forces the journal batch out (a durability point between settles). */
  flush(): Promise<void> {
    return this.serialize(() => this.session.flush());
  }

  /** Settles the session once (see the epoch-rotation rule) and applies the backstops. */
  settle(): Promise<InstanceSettleReport> {
    return this.serialize(() => this.runSettle());
  }

  private async runSettle(): Promise<InstanceSettleReport> {
    // The session is asked once and its report kept: a retried settle (a revoke or the enqueue
    // failed last time) redoes only the wrapper's idempotent side effects. A second
    // session.settle() would find the chunk postings a failed netted attempt left compensated,
    // mis-read them as settled, and erase the replay's rejections — and the revokes with them.
    const report = (this.settleReport ??= await this.session.settle());

    // The cross-lane backstop runs here: a movement the replay path refused moved no money, so
    // the ownership its grant handed out must not stand.
    const revoked: Array<{ buyerId: string; sku: string; orderId: string }> =
      [];
    for (const rejection of report.rejected) {
      const grant = this.granted.get(rejection.idempotencyKey);
      if (grant === undefined) {
        continue;
      }
      await this.deps.store.entitlements.revoke(grant.buyerId, grant.sku, {
        source: saleSource(rejection.idempotencyKey),
      });
      revoked.push({ ...grant, orderId: rejection.idempotencyKey });
      this.deps.logger?.log('warn', 'instance.settle.revoked', {
        sessionId: this.sessionId,
        orderId: rejection.idempotencyKey,
        reason: rejection.reason,
      });
    }

    await this.releaseImmatureHolds();
    await this.refundRemainders();
    // The event queues once per lane: a retried settle (a revoke or the enqueue failed last
    // time) must not queue a second settled event. Delivery stays at-least-once, the outbox's
    // normal contract: an enqueue that committed but lost its ack re-runs.
    if (!this.settledEmitted) {
      await this.emitSettled(report, revoked.length);
      this.settledEmitted = true;
    }
    return { ...report, revoked };
  }

  /** This epoch's accepted and rejected purchase counts. The manager's sweep reads `accepted` against its rotation bound. */
  stats(): { accepted: number; rejected: number } {
    return { accepted: this.accepted, rejected: this.rejected };
  }

  /** The buyer's accepted spend this epoch — the total `perUserCapMinor` screens against. */
  spentOf(userId: string): Amount {
    return toAmount('CREDIT', this.spent.get(userId) ?? 0n);
  }

  // --- Internals --------------------------------------------------------------------

  // Queues one writer behind the last. A failed writer never blocks the next.
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run);
    this.tail = next.catch(() => {});
    return next;
  }

  // Builds spend's split, spendable-only: buyer debit, then the injected fee policy's credit
  // lines (sellers' earned net plus REVENUE's fee and rounding leftover). Rounding is identical
  // to the main lane, so settle nets land on the same accounts to the last minor unit. Zero
  // legs drop exactly as postEntry drops them. The fee policy rounds fees up to whole credit
  // units, so a price of a few credits rounds entirely into the fee and the creator nets zero.
  // Micro prices must stay above that floor.
  private legsOf(input: InstancePurchase): Leg[] {
    const debitFrom =
      this.prefund === null
        ? spendable(input.buyerId)
        : sessionEscrow(input.buyerId, this.sessionId);
    const legs: Leg[] = [debit(debitFrom, input.price)];
    for (const leg of this.deps.pricing({
      price: input.price,
      recipients: input.recipients,
      feeBps: this.config.platformFeeBps,
      buyerId: input.buyerId,
      sku: input.product.sku,
    })) {
      if (leg.amount.minor !== 0n) {
        legs.push(leg);
      }
    }
    return legs;
  }

  // Prefund's funding step runs once per buyer per session: a real posting moves the escrow
  // amount from spendable into the (user, session) escrow account. The posting is durable
  // before any movement spends it. It is matured-only: the maturity gate applies at funding, so
  // the escrow needs no immature hold. It is idempotent by deterministic txn id, so a replayed
  // epoch probes before posting. False means the buyer cannot fund: not enough matured
  // spendable.
  private async ensurePrefunded(buyerId: string): Promise<boolean> {
    if (this.funded.has(buyerId)) {
      return true;
    }
    const amountMinor = this.prefund!.amountMinor;
    const txnId = `esc_fund_${this.sessionId}_${buyerId}`;
    if ((await this.deps.store.ledger.posting(txnId)) !== null) {
      this.funded.add(buyerId);
      return true;
    }
    const matured = await maturedBalance(
      this.deps.store.ledger,
      spendable(buyerId),
      this.deps.clock.now(),
      { config: this.config },
    );
    if (matured.minor < amountMinor) {
      return false;
    }
    const amount = toAmount('CREDIT', amountMinor);
    await this.deps.store.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId,
        legs: [
          debit(spendable(buyerId), amount),
          credit(sessionEscrow(buyerId, this.sessionId), amount),
        ],
        meta: { kind: 'prefund', sessionId: this.sessionId, userId: buyerId },
      }),
    );
    this.funded.add(buyerId);
    return true;
  }

  // Prefund's closing step: whatever each escrow still holds after settle goes back to
  // spendable. The refund is idempotent by deterministic txn id, so a crashed refund re-runs
  // clean. The orphan sweep repairs the same way for a lane that never came back.
  private async refundRemainders(): Promise<void> {
    if (this.prefund === null) {
      return;
    }
    for (const buyerId of this.funded) {
      await refundEscrowRemainder(this.deps.store, this.sessionId, buyerId);
    }
  }

  private async holdImmature(buyerId: string): Promise<void> {
    if (this.immatureHeld.has(buyerId)) {
      return;
    }
    const account = spendable(buyerId);
    const live = await this.deps.store.ledger.balance(account);
    const matured = await maturedBalance(
      this.deps.store.ledger,
      account,
      this.deps.clock.now(),
      { config: this.config },
    );
    const immature = live.minor - matured.minor;
    this.immatureHeld.set(buyerId, immature);
    if (immature > 0n) {
      await this.reservations.add(account, -immature);
    }
  }

  private async releaseImmatureHolds(): Promise<void> {
    // Each entry leaves the map as its hold returns, so a retried settle after a mid-loop
    // registry failure releases only what is still held.
    for (const [buyerId, immature] of this.immatureHeld) {
      if (immature > 0n) {
        await this.reservations.add(spendable(buyerId), immature);
      }
      this.immatureHeld.delete(buyerId);
    }
  }

  private overCap(buyerId: string, priceMinor: bigint): boolean {
    if (this.capMinor === null) {
      return false;
    }
    return (this.spent.get(buyerId) ?? 0n) + priceMinor > this.capMinor;
  }

  private orderIdOf(input: InstancePurchase): string {
    const prefix = sessionOrderPrefix(this.sessionId);
    if (input.orderId === undefined) {
      const orderId = `${prefix}${this.orderSeq}`;
      this.orderSeq += 1;
      return orderId;
    }
    if (!input.orderId.startsWith(prefix)) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'A session orderId must carry its session prefix, so it can never collide with a main-lane order.',
        { detail: { orderId: input.orderId, prefix } },
      );
    }
    return input.orderId;
  }

  // Shape rules mirrored from spend's, minus what the lane excludes by design. These throw
  // faults, not rejections: the economy service builds these inputs, so a bad one is a wiring
  // bug.
  private validate(input: InstancePurchase): void {
    // This lane posts without passing validateOperation — a purchase is not an Operation — so the
    // wire shapes it shares with spend are checked here, against the contract's own predicates.
    // An id reaches an account by interpolation, so a non-string one would post to
    // `[object Object]:spendable`.
    for (const [field, spec, value] of [
      ['buyerId', 'string', input.buyerId],
      ['product.sku', 'string', input.product.sku],
      ['price', 'amount', input.price],
      ['recipients', 'recipients', input.recipients],
    ] as ReadonlyArray<[string, Spec, unknown]>) {
      if (!hasWireShape(spec, value)) {
        throw fault(
          ERROR_CODES.MALFORMED_OPERATION,
          `A session purchase's ${field} has the wrong shape.`,
          { detail: { field, spec } },
        );
      }
    }
    if (input.price.currency !== 'CREDIT' || input.price.minor <= 0n) {
      throw fault(
        ERROR_CODES.INVALID_AMOUNT,
        'A session purchase price must be positive CREDIT.',
        { detail: { buyerId: input.buyerId } },
      );
    }
    if (input.product.sku.trim() === '') {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'A session purchase names a non-empty sku.',
        { detail: { buyerId: input.buyerId } },
      );
    }
    // The wire can hand any string. Unchecked, an unknown kind would ride the grant-carrying
    // path as if it were permanent.
    if (!PRODUCT_KINDS.has(input.product.kind)) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'A session purchase kind must be permanent, temporary, or instant.',
        { detail: { sku: input.product.sku, kind: input.product.kind } },
      );
    }
    const temporary = input.product.kind === 'temporary';
    if (temporary !== (input.product.expiresAt !== undefined)) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'expiresAt is required for a temporary product and forbidden otherwise.',
        { detail: { sku: input.product.sku, kind: input.product.kind } },
      );
    }
    assertRecipientShares(input.recipients, input.buyerId, 'session purchase');
  }

  private metered(
    input: InstancePurchase,
    outcome: PurchaseOutcome,
  ): PurchaseOutcome {
    this.outcomes.set(outcome.orderId, outcome);
    try {
      this.deps.meter?.count('instance.purchase', 1, {
        kind: input.product.kind,
        status: outcome.status,
      });
    } catch {
      // Telemetry only.
    }
    return outcome;
  }

  private async emitSettled(
    report: SettleReport,
    revokedCount: number,
  ): Promise<void> {
    const event: EconomyEvent = {
      id: this.deps.ids.next('evt'),
      type: 'economy.instance.settled',
      version: EVENT_VERSION,
      occurredAt: this.deps.clock.now(),
      subject: this.sessionId,
      audience: 'internal',
      data: {
        sessionId: this.sessionId,
        mode: report.mode,
        netted: report.netted,
        postings: report.postings,
        rejected: report.rejected.length,
        revoked: revokedCount,
      },
    };
    await this.deps.store.transaction((unit) =>
      unit.outbox.enqueue(pendingOutbox(this.deps.ids, event)),
    );
  }
}

// --- The lane manager: in-process routing, epoch rotation, idle settling -----------

/** The default epoch age bound (ms), shared by the lane manager's sweep and the cluster node's epoch-age law. */
export const DEFAULT_EPOCH_MAX_AGE_MS = 60_000;

/**
 * How the manager paces epochs. Either bound rotates the scope's lane at the next `sweep`.
 * Movement-count bounds the settle's journal walk; age bounds how long money stays un-netted.
 */
export type InstanceEconomiesOptions = {
  lane?: Omit<InstanceEconomyOptions, 'reservations'>;

  /** Rotate a scope once its epoch accepted this many purchases. Default 512. */
  epochMaxMovements?: number;

  /** Rotate a scope once its epoch is this old. Default 60_000 ms. */
  epochMaxAgeMs?: number;

  /**
   * The registry every lane shares. The default is a private per-process registry (single-node).
   * A multi-node deployment passes `sharedReservations(store)` here so every node's accept
   * screen sees every other node's pending — the host opt-in for cross-node correctness.
   */
  reservations?: Reservations;
};

/** One manager pass over due scopes: what settled, and what failed and stays for retry. */
export type InstanceSweepReport = {
  settled: ReadonlyArray<{ scope: string; report: InstanceSettleReport }>;
  /** These scopes' lanes are retained; the next sweep retries them. */
  failed: ReadonlyArray<{ scope: string; code: string }>;
};

/**
 * The process-level front door to the fast lane. It hands out the live lane for any scope key,
 * opening on demand, and it owns the rules a host must never get wrong: every lane shares one
 * reservations registry, epochs rotate instead of ever re-settling a session id (ids come from
 * `epochMinter`), and a failed settle keeps its lane for retry instead of
 * stranding the epoch.
 *
 * The host deliberately owns routing across processes. `scopeRouter` provides
 * the consistent-hash assignment, kept sticky for the scope's life. On failover,
 * `recoverSession` with the crashed epoch's session id finishes its settle, and the orphan
 * sweep enumerates crashed epochs from the journal.
 *
 * The example below is the whole host program, over an openPorts composition:
 *
 * @example
 * const ports = await openPorts(process.env, init);
 * const lanes = openInstanceEconomies(ports, {
 *   epochMaxAgeMs: 30_000, // optional: rotate a scope once its epoch is this old
 *   epochMaxMovements: 512, // optional: rotate a scope once its epoch accepted this many
 *   reservations: sharedReservations(ports.store), // optional: multi-node; default is per-process
 *   lane: { // optional: per-lane knobs
 *     perUserCapMinor: 500_000n, // optional: one buyer's epoch ceiling (5,000 credits)
 *     maxBatch: 64, // optional: accepted movements per journal batch
 *     chunkWidth: 16, // optional: max participant accounts per settlement chunk
 *     prefund: { amountMinor: 120_000n }, // optional: escrow 1,200 credits per buyer up front
 *   },
 * });
 * const stopSettling = lanes.start(5_000); // rotate due epochs on cadence
 *
 * // Per request from a game server (an unprivileged caller):
 * const outcome = await lanes.laneFor(worldInstanceId).purchase({
 *   buyerId: 'usr_buyer',
 *   price: toAmount('CREDIT', 40_000n), // 400 credits, a mid-catalog in-world listing
 *   recipients: [{ sellerId: 'usr_creator', shareBps: 10_000 }], // all of the post-fee net
 *   product: {
 *     sku: 'wrld_hat',
 *     kind: 'permanent',
 *     // expiresAt: required for kind 'temporary', forbidden otherwise
 *   },
 *   // orderId: optional; defaults to <sessionId>:<n>, and a supplied one must carry the session prefix
 * });
 * if (outcome.status === 'rejected') {
 *   deny(outcome.orderId, outcome.reason); // e.g. 'INSUFFICIENT_FUNDS' or 'RISK_DENIED'
 * }
 *
 * // Shutdown or drain:
 * stopSettling();
 * await lanes.settleAll();
 */
export function openInstanceEconomies(
  deps: InstanceEconomyDeps,
  options: InstanceEconomiesOptions = {},
): InstanceEconomies {
  return new InstanceEconomies(deps, options);
}

type ScopeLane = { lane: InstanceEconomy; openedAt: number };

/**
 * The lane manager's handle. `laneFor` hands out the scope's current-epoch lane, opening on
 * demand. `rotate` settles one scope now. `sweep` rotates every scope past its movement or age
 * bound. `settleAll` drains everything. `start` runs the sweep on a timer. `pending` and
 * `stats` read across every lane.
 *
 * A settle that throws keeps its lane, so the next sweep retries instead of stranding the
 * epoch.
 *
 * Construct through {@link openInstanceEconomies}.
 */
export class InstanceEconomies {
  private readonly deps: InstanceEconomyDeps;
  private readonly options: InstanceEconomiesOptions;
  private readonly registry: Reservations;
  private readonly lanes = new Map<string, ScopeLane>();
  private readonly mint: (scope: string) => string;

  constructor(deps: InstanceEconomyDeps, options: InstanceEconomiesOptions) {
    this.deps = deps;
    this.options = options;
    this.registry = options.reservations ?? createReservations();
    this.mint = epochMinter(deps.ids);
  }

  /** The scope's current-epoch lane, opened on demand. */
  laneFor(scope: string): InstanceEconomy {
    const open = this.lanes.get(scope);
    if (open !== undefined) {
      return open.lane;
    }
    const lane = openInstanceEconomy(this.deps, this.mint(scope), {
      ...(this.options.lane ?? {}),
      reservations: this.registry,
    });
    this.lanes.set(scope, { lane, openedAt: this.deps.clock.now() });
    return lane;
  }

  /**
   * Settles the scope's current epoch now. The next `laneFor` opens the next epoch. A settle
   * that throws keeps the lane (a settled session refuses new movements on its own, and the
   * journal is durable), so the next rotate or sweep retries instead of stranding the epoch.
   */
  async rotate(scope: string): Promise<InstanceSettleReport | null> {
    const open = this.lanes.get(scope);
    if (open === undefined) {
      return null;
    }
    const report = await open.lane.settle();
    this.lanes.delete(scope);
    return report;
  }

  /** Rotates every scope whose epoch is over its movement or age bound — the cadence hook. */
  sweep(): Promise<InstanceSweepReport> {
    const maxMovements = this.options.epochMaxMovements ?? 512;
    const maxAgeMs = this.options.epochMaxAgeMs ?? DEFAULT_EPOCH_MAX_AGE_MS;
    const now = this.deps.clock.now();
    const due: string[] = [];
    for (const [scope, open] of this.lanes) {
      const { accepted } = open.lane.stats();
      if (accepted >= maxMovements || now - open.openedAt >= maxAgeMs) {
        due.push(scope);
      }
    }
    return this.rotateAll(due);
  }

  /** Rotates everything — the shutdown or drain hook. */
  settleAll(): Promise<InstanceSweepReport> {
    return this.rotateAll([...this.lanes.keys()]);
  }

  /**
   * Runs `sweep` on a timer — the Scheduler port when the deps carry one, a built-in interval
   * otherwise — and returns the stop function. Stopping the timer settles nothing. Call
   * `settleAll` to drain.
   */
  start(everyMs: number): () => void {
    const scheduler = this.deps.scheduler ?? intervalScheduler();
    return scheduler.every(everyMs, async () => {
      await this.sweep();
    });
  }

  /**
   * The user's pending-out total across every lane this manager runs — they share one
   * registry, so a display layer shows `balance - pending` with one call, whatever scope the
   * spend is in.
   */
  async pending(userId: string): Promise<Amount> {
    const natural = await this.registry.pending(spendable(userId));
    return toAmount('CREDIT', natural < 0n ? -natural : 0n);
  }

  /** The dashboard roll-up across every open lane. */
  stats(): { scopes: number; accepted: number; rejected: number } {
    let accepted = 0;
    let rejected = 0;
    for (const open of this.lanes.values()) {
      const lane = open.lane.stats();
      accepted += lane.accepted;
      rejected += lane.rejected;
    }
    return { scopes: this.lanes.size, accepted, rejected };
  }

  // One failing scope must not stop the others, and its lane stays for the next retry — a
  // sweep-shaped failure contract, like every worker sweep in this repo.
  private async rotateAll(
    scopes: ReadonlyArray<string>,
  ): Promise<InstanceSweepReport> {
    const settled: Array<{ scope: string; report: InstanceSettleReport }> = [];
    const failed: Array<{ scope: string; code: string }> = [];
    for (const scope of scopes) {
      try {
        const report = await this.rotate(scope);
        if (report !== null) {
          settled.push({ scope, report });
        }
      } catch (error) {
        const code = normalizeError(error).code;
        failed.push({ scope, code });
        this.deps.logger?.log('error', 'instance.sweep.settle_failed', {
          scope,
          code,
        });
      }
    }
    try {
      this.deps.meter?.count('instance.settle', settled.length, {
        outcome: 'settled',
      });
      this.deps.meter?.count('instance.settle', failed.length, {
        outcome: 'failed',
      });
    } catch {
      // Telemetry only.
    }
    return { settled, failed };
  }
}
