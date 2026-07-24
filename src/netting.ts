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
 * Session netting: accept thousands of small balanced movements (in-world product purchases —
 * permanent, temporary, or instant) into a durable journal and settle the net against the ledger
 * on the economy service's own schedule. The journal is the source of truth, never session
 * memory — rows are hash-chained per session and the settlement posting anchors the final head,
 * so tamper-evidence extends from the proved ledger to every movement.
 *
 * A session is an economy-tier serialization object with an opaque scope key. A game-world
 * instance is one natural key and lifecycle signal for a session; it is never the owner: game
 * servers are unprivileged callers that request movements, and the economy service — the process
 * holding the store, the journal, and the reservation registry — screens, journals, and settles.
 * Settle timing is this tier's policy (cadence, backlog, timeout, or scope close), never a
 * correctness dependency of the scope's lifetime.
 *
 * A session settles once: its settlement txn ids derive from the session id, so a re-settled
 * session would collide with its own chunks and silently strand later movements. `record` on a
 * settled session therefore throws. Long-lived scopes rotate epochs instead — settle
 * `sess:<scope>:<n>` while `sess:<scope>:<n+1>` records.
 *
 * Opt-in, on purpose: per-movement enforcement moves to the session (DB-final at settle) and
 * movements bypass the submit pipeline's maturity gate — callers that need that gate screen
 * before building legs (see maturedBalance in src/maturity.ts).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 *   chain-and-anchor construction the journal reuses.
 */

import {
  GENESIS_HEX,
  credit,
  debit,
  postEntry,
  balanceDelta,
} from '#src/ledger.ts';
import {
  isWalletAccount,
  sessionEscrow,
  spendable,
  SYSTEM,
} from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import { toHex } from '#src/bytes.ts';
import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { ErrorCode, RejectionCode } from '#src/errors.ts';
import type { Amount, Currency } from '#src/money.ts';
import type { Clock, Digest, Ids, Leg, Movement, Store } from '#src/ports.ts';

const ENCODER = new TextEncoder();

/** One movement offered to the session: an idempotency key and a balanced set of CREDIT legs. */
export interface MovementRequest {
  idempotencyKey: string;
  legs: ReadonlyArray<Leg>;
}

/** What became of one offered movement. Accepted movements turn ledger-final at settle. */
export type MovementOutcome =
  | { status: 'accepted'; seq: number }
  | { status: 'rejected'; reason: RejectionCode | ErrorCode };

/** How the session reached the ledger: one net posting per chunk, or movement-by-movement. */
export interface SettleReport {
  mode: 'netted' | 'replayed';

  /** Net postings committed (chunks in 'netted' mode; individual movements in 'replayed'). */
  postings: number;

  /** Movements the replay path refused, by idempotency key (empty in 'netted' mode). */
  rejected: ReadonlyArray<{
    idempotencyKey: string;
    reason: RejectionCode | ErrorCode;
  }>;

  /** The session chain head the settlement anchored. */
  journalHead: string;

  /** How many accepted movements the settlement covers. */
  netted: number;
}

/**
 * The cross-session reservation registry: one shared per-user-account pending total, bumped at
 * accept time, released at settle. `add` returns the post-add total, so accept screens are
 * add-then-check — two concurrent debits can never both read the same headroom, in one process
 * or across nodes. Share one registry across every session in the process
 * ({@link createReservations}), or across every node ({@link sharedReservations}, backed by the
 * store's counter). The settle replay path remains the backstop for crash-recovery windows
 * either way.
 *
 * `scope` decides crash-recovery behavior: a `process` registry dies with its process, so
 * {@link recoverSession} re-applies the journaled reservations; a `shared` counter survives the
 * crash already holding them, so recovery must not re-apply — it would double-count.
 */
export interface Reservations {
  readonly scope: 'process' | 'shared';
  pending(account: AccountRef): Promise<bigint> | bigint;
  add(account: AccountRef, naturalDelta: bigint): Promise<bigint> | bigint;
}

/**
 * Creates a process-local registry: a plain in-memory map, no store round-trips. Right for a
 * single-node deployment, shared by every session in the process. Its totals die with the
 * process, so {@link recoverSession} re-applies journaled reservations on recovery (see
 * `scope` on {@link Reservations}); a multi-node deployment uses {@link sharedReservations}
 * instead.
 */
export function createReservations(): Reservations {
  const pending = new Map<AccountRef, bigint>();
  return {
    scope: 'process',
    pending: (account) => pending.get(account) ?? 0n,
    add: (account, naturalDelta) => {
      const total = (pending.get(account) ?? 0n) + naturalDelta;
      pending.set(account, total);
      return total;
    },
  };
}

/**
 * A registry every node shares, backed by the store's `ReservationStore` counter — the
 * multi-node accept screen. Fail-closed by construction: an unreachable counter throws out of
 * `add`, and `record` refuses the movement rather than accepting blind.
 *
 * Crash accounting: a dead node's journaled reservations release precisely when the orphan
 * sweep settles its sessions (release is journal-derived). Movements accepted but not yet
 * flushed die with the process while their reservations remain — a leak bounded by `maxBatch`
 * per crashed session that only ever refuses movements (conservative), never accepts wrongly;
 * `reconcileReservations` (src/worker/orphans.ts) is the quiesced-maintenance repair.
 */
export function sharedReservations(store: Store): Reservations {
  const counter = store.reservations;
  if (counter === undefined) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'This store offers no shared reservation counter.',
      { retryable: false },
    );
  }
  return {
    scope: 'shared',
    pending: (account) => counter.pending(account),
    add: (account, naturalDelta) => counter.add(account, naturalDelta),
  };
}

/**
 * Mints epoch session ids, `sess:<scope>:<nonce>-<n>`, counting epochs per scope. The nonce —
 * the uuid tail of a fresh id, which keeps it injectable and deterministic in tests — brands
 * every id this process instance mints, so a restarted process can never reuse a session id an
 * earlier process already settled (the settle-once collision, resurrected across restarts).
 */
export function epochMinter(ids: Ids): (scope: string) => string {
  const nonce = ids.next('evt').slice(-12);
  const epochs = new Map<string, number>();
  return (scope) => {
    const epoch = epochs.get(scope) ?? 0;
    epochs.set(scope, epoch + 1);
    return `sess:${scope}:${nonce}-${epoch}`;
  };
}

/**
 * The ports a session runs on: the store for the journal and the settlement postings, the
 * digest for the session chain hash, the clock for `recordedAt` stamps. A structural subset of
 * Ports, so an openPorts host passes its ports straight through.
 */
export interface SessionPorts {
  store: Store;
  digest: Digest;
  clock: Clock;
}

/**
 * Session tuning. The batch and chunk defaults are sized to the engines' contention profile;
 * the one option correctness rides on is `reservations` — every session in the process shares
 * one registry, or its accept screens race each other.
 */
export interface SessionOptions {
  /** Accepted movements per journal batch; the batch commits as one insert. Default 64. */
  maxBatch?: number;

  /** Max participant accounts per settlement chunk (the lock-width bound). Default 16. */
  chunkWidth?: number;

  /** The shared cross-session registry; a private one still guards within this session. */
  reservations?: Reservations;
}

/**
 * Opens a netting session. `record` accepts or rejects movements (idempotent per key, affordable
 * per the reservation registry, durable per journal batch); `flush` forces the pending batch out;
 * `settle` derives the net from the journal, verifies the chain, and posts it in clearing
 * chunks — once per session id; rotate epochs to keep a long-lived scope settling on cadence.
 *
 * `deps` is a structural subset of `Ports`, so a host composed via
 * `openPorts` passes its ports straight through. Share ONE `reservations`
 * registry across every session in the process (see {@link Reservations}).
 *
 * @example
 * // In the economy service, keyed by (not owned by) a world instance, epoch-rotated. A
 * // purchase movement carries the same fee split a main-lane sale posts: buyer debit,
 * // seller's net credit, REVENUE's fee credit.
 * const ports = await openPorts(process.env, init);
 * const reservations = createReservations(); // one per process
 * const session = openInstanceSession(ports, `sess:${worldInstanceId}:0`, { reservations });
 * const price = decodeAmount('5.00', 'CREDIT');
 * const fee = decodeAmount('1.50', 'CREDIT');
 * await session.record({
 *   idempotencyKey: orderId,
 *   legs: [
 *     debit(spendable(buyerId), price),
 *     credit(earned(creatorId), subtract(price, fee)),
 *     credit(SYSTEM.REVENUE, fee),
 *   ],
 * });
 * await session.settle(); // this tier's schedule: cadence, backlog, timeout, or scope close
 */
export function openInstanceSession(
  deps: SessionPorts,
  sessionId: string,
  options?: SessionOptions,
): InstanceSession {
  return new InstanceSession(deps, sessionId, options);
}

/**
 * Rebuilds a session from its journal — the crash-recovery path. Outcomes, the running net, and
 * the chain head all re-derive from the journal rows; a rebuilt session can keep recording (if
 * it never settled) or go straight to settle, and settle keying each chunk on its posting's
 * existence makes a half-settled session finish rather than double-post. Recovery probes for a
 * prior settlement posting: a session that already settled refuses further movements the same
 * way a live one does, so recovery can finish a settle but never reopen a settled epoch.
 */
export async function recoverSession(
  deps: SessionPorts,
  sessionId: string,
  options?: SessionOptions,
): Promise<InstanceSession> {
  const session = new InstanceSession(deps, sessionId, options);
  await session.__recover();
  return session;
}

/**
 * Refunds one prefund escrow's remainder to its owner's spendable balance, by the deterministic
 * `esc_refund_` txn id every repair path shares: the lane's own close, the orphan sweep, and the
 * retention sweep post this identical entry, so whichever runs first wins and the rest no-op on
 * the existing posting. Returns the refunded minor amount, or null when the escrow is empty or
 * already refunded.
 */
export async function refundEscrowRemainder(
  store: Store,
  sessionId: string,
  userId: string,
): Promise<bigint | null> {
  const escrow = sessionEscrow(userId, sessionId);
  const remainder = await store.ledger.balance(escrow);
  if (remainder.minor <= 0n) {
    return null;
  }
  const txnId = `esc_refund_${sessionId}_${userId}`;
  if ((await store.ledger.posting(txnId)) !== null) {
    return null;
  }
  await store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId,
      legs: [debit(escrow, remainder), credit(spendable(userId), remainder)],
      meta: { kind: 'prefund_refund', sessionId, userId },
    }),
  );
  return remainder.minor;
}

/**
 * A durable journal session: `record` accepts movements (idempotent per key, screened against
 * the reservation registry), `flush` commits the pending batch, `settle` re-derives the net
 * from the journal, re-verifies the hash chain, and posts it in clearing chunks — once per
 * session id, epochs rotate after that. Construct through {@link openInstanceSession}, or
 * {@link recoverSession} after a crash. A session is a single-writer object: interleaved
 * concurrent `record` calls can fork the chain on one seq, so a concurrent edge serializes on
 * top (as {@link InstanceEconomy} does).
 */
export class InstanceSession {
  private readonly deps: SessionPorts;
  private readonly sessionId: string;
  private readonly maxBatch: number;
  private readonly chunkWidth: number;
  private readonly reservations: Reservations;

  private readonly outcomes = new Map<string, MovementOutcome>();
  private settled = false; // set by a non-empty settle; a settled session takes no new movements
  // Recovery found replay or compensation postings: this settle must go straight to the replay
  // path, whose per-movement txn ids are idempotent. The netted path would mis-read a
  // compensated chunk as posted (skipping its money) or re-post movements the replay already
  // made ledger-final.
  private replayForced = false;
  private readonly accepted: Movement[] = []; // every accepted movement, in seq order
  private pending: Movement[] = []; //           accepted but not yet journaled
  private readonly opening = new Map<AccountRef, bigint>(); // first-touch balance reads
  private head = GENESIS_HEX;
  private seq = 0;

  constructor(deps: SessionPorts, sessionId: string, options?: SessionOptions) {
    this.deps = deps;
    this.sessionId = sessionId;
    // 64 default: at or under the Postgres cached-subxid cliff (see runBatchTransaction in
    // src/engines/postgres.ts); 16 keeps a settle chunk's lock set narrow.
    this.maxBatch = options?.maxBatch ?? 64;
    this.chunkWidth = options?.chunkWidth ?? 16;
    this.reservations = options?.reservations ?? createReservations();
  }

  /**
   * Accepts or rejects one movement. Acceptance means: affordable against (first-touch balance +
   * everything pending across sessions sharing the registry) and queued for the next journal
   * batch. Unbalanced or non-CREDIT legs throw. A repeat of a seen key replays its recorded
   * outcome.
   */
  async record(request: MovementRequest): Promise<MovementOutcome> {
    if (this.settled) {
      throw fault(
        ERROR_CODES.SESSION_SETTLED,
        'A settled session refuses further movements; rotate to a new session id (epoch).',
        { detail: { sessionId: this.sessionId } },
      );
    }
    const replay = this.outcomes.get(request.idempotencyKey);
    if (replay) {
      return replay;
    }

    const rejection = await this.reserve(request.legs);
    if (rejection) {
      return this.remember(request.idempotencyKey, {
        status: 'rejected',
        reason: rejection,
      });
    }

    const movement: Movement = {
      sessionId: this.sessionId,
      seq: this.seq,
      idempotencyKey: request.idempotencyKey,
      legs: request.legs.map((leg) => ({ ...leg })),
      prevHash: this.head,
      hash: await this.chain(this.head, request),
      recordedAt: this.deps.clock.now(),
    };
    this.seq += 1;
    this.head = movement.hash;
    this.accepted.push(movement);
    this.pending.push(movement);
    const outcome = this.remember(request.idempotencyKey, {
      status: 'accepted',
      seq: movement.seq,
    });
    if (this.pending.length >= this.maxBatch) {
      await this.flush();
    }
    return outcome;
  }

  /** Commits the pending batch to the journal — one insert, one fsync for the whole batch. */
  async flush(): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    await this.deps.store.movements.append(batch);
  }

  /**
   * Settles the whole session: flush, re-derive the net from the JOURNAL (never from memory),
   * re-verify the session chain, then post the net in clearing chunks. On a refused chunk,
   * compensate what posted and replay movement-by-movement, so every accepted movement ends in
   * exactly one ledger-final outcome either way.
   */
  async settle(): Promise<SettleReport> {
    await this.flush();
    const movements = await this.journal();
    if (movements.length === 0) {
      return {
        mode: 'netted',
        postings: 0,
        rejected: [],
        journalHead: GENESIS_HEX,
        netted: 0,
      };
    }
    const head = movements[movements.length - 1]!.hash;
    if (this.replayForced) {
      this.settled = true;
      return this.replay(movements, head);
    }

    const net = new Map<AccountRef, bigint>();
    for (const movement of movements) {
      for (const leg of movement.legs) {
        net.set(leg.account, (net.get(leg.account) ?? 0n) + leg.amount.minor);
      }
    }
    const positions = [...net].filter(([, minor]) => minor !== 0n);
    const chunks: Array<Array<[AccountRef, bigint]>> = [];
    for (let i = 0; i < positions.length; i += this.chunkWidth) {
      chunks.push(positions.slice(i, i + this.chunkWidth));
    }

    const posted: number[] = [];
    const shape = {
      of: chunks.length,
      netted: movements.length,
      journalHead: head,
    };
    try {
      for (let i = 0; i < chunks.length; i++) {
        await this.postChunk(chunks[i]!, { index: i, ...shape });
        posted.push(i);
      }
    } catch {
      // A chunk was refused (the cross-instance race, or funds spent since accept). Undo what
      // posted — the compensations return clearing to zero — then replay each movement
      // individually.
      for (const i of posted.reverse()) {
        await this.postChunk(chunks[i]!, { index: i, ...shape }, true);
      }
      this.settled = true;
      return this.replay(movements, head);
    }

    await this.releaseReservations();
    this.settled = true;
    return {
      mode: 'netted',
      postings: chunks.length,
      rejected: [],
      journalHead: head,
      netted: movements.length,
    };
  }

  // --- Internals --------------------------------------------------------------------

  // Structural wrongness throws (the host builds these legs, so a bad set is a bug); the only
  // expected "no" is INSUFFICIENT_FUNDS against first-touch balance + all pending.
  //
  // Reservation is add-then-check per guarded leg: the post-add total `add` returns already
  // includes every other session's — and node's — pending, so two concurrent debits can never
  // both read the same headroom, and several debit legs to one account in one movement check
  // cumulatively. A failed check or a registry error backs out this movement's applied legs;
  // an unreachable shared registry therefore refuses the movement (fail-closed), never accepts
  // blind.
  private async reserve(
    legs: ReadonlyArray<Leg>,
  ): Promise<RejectionCode | null> {
    let sum = 0n;
    for (const leg of legs) {
      if (leg.amount.currency !== 'CREDIT' || leg.amount.minor === 0n) {
        throw fault(
          ERROR_CODES.MALFORMED_OPERATION,
          'A movement leg must carry a nonzero CREDIT amount.',
          { detail: { account: leg.account } },
        );
      }
      sum += leg.amount.minor;
    }
    if (sum !== 0n || legs.length === 0) {
      throw fault(
        ERROR_CODES.LEDGER_UNBALANCED,
        'A movement must carry legs that sum to zero.',
      );
    }
    const applied: Array<[AccountRef, bigint]> = [];
    try {
      for (const leg of legs) {
        if (!isWalletAccount(leg.account)) {
          continue;
        }
        const delta = balanceDelta(leg).minor;
        const total = await this.reservations.add(leg.account, delta);
        applied.push([leg.account, delta]);
        if (delta < 0n) {
          const opening = await this.openingBalance(leg.account);
          if (opening + total < 0n) {
            await this.unwind(applied);
            return 'INSUFFICIENT_FUNDS';
          }
        }
      }
    } catch (error) {
      // The original error keeps propagating; a failed backout only leaves pending high (see unwind).
      await this.unwind(applied).catch(() => {});
      throw error;
    }
    return null;
  }

  // Backs out the legs `reserve` applied, newest first. Best effort on the error path: if the
  // registry is down the backout fails too, leaving the pending total high — which only refuses
  // movements, the conservative direction.
  private async unwind(
    applied: ReadonlyArray<[AccountRef, bigint]>,
  ): Promise<void> {
    for (const [account, delta] of [...applied].reverse()) {
      await this.reservations.add(account, -delta);
    }
  }

  private async openingBalance(account: AccountRef): Promise<bigint> {
    const known = this.opening.get(account);
    if (known !== undefined) {
      return known;
    }
    const balance = await this.deps.store.ledger.balance(account);
    this.opening.set(account, balance.minor);
    return balance.minor;
  }

  private released = false;

  // Idempotent on purpose: a re-settled session (recovery, or a caller retrying) must not drive
  // the shared registry negative by releasing the same reservations twice. Release is derived
  // from `accepted` — after recovery that is exactly the journaled movements, so a shared
  // counter releases precisely what the journal proves was reserved.
  //
  // For a shared counter the in-memory flag cannot carry that idempotence across processes: a
  // node that crashed after releasing would be released again by whoever recovers the session,
  // driving the counter negative — over-granting headroom, the one non-conservative direction.
  // So shared-scope release is gated by a durable idempotency claim on the session id: exactly
  // one process ever runs it. A crash after the claim commits but mid-release leaves pending
  // high, which only refuses movements; reconcileReservations (src/worker/orphans.ts) is the
  // quiesced repair.
  private async releaseReservations(): Promise<void> {
    if (this.released) {
      return;
    }
    if (this.reservations.scope === 'shared') {
      const key = `resv_release:${this.sessionId}`;
      const won = await this.deps.store.transaction(async (unit) => {
        const claim = await unit.idempotency.claim(key);
        if (!claim.claimed) {
          return false;
        }
        await unit.idempotency.record(key, {
          id: key,
          postedAt: this.deps.clock.now(),
          legs: [],
          links: [],
          meta: { kind: 'reservation_release', sessionId: this.sessionId },
        });
        return true;
      });
      if (!won) {
        this.released = true;
        return;
      }
    }
    for (const movement of this.accepted) {
      for (const leg of movement.legs) {
        if (isWalletAccount(leg.account)) {
          await this.reservations.add(leg.account, -balanceDelta(leg).minor);
        }
      }
    }
    // The flag is set only once release completed, so a transient claim failure retries
    // instead of skipping the release forever.
    this.released = true;
  }

  private remember(key: string, outcome: MovementOutcome): MovementOutcome {
    this.outcomes.set(key, outcome);
    return outcome;
  }

  // The session chain hash: the previous head, the movement's key, and its legs in canonical
  // text, through the injected digest. The settlement posting anchors the final head, which is
  // what makes every journal row tamper-evident through the proved ledger.
  private async chain(
    prevHash: string,
    request: MovementRequest,
  ): Promise<string> {
    const legs = request.legs
      .map((leg) => `${leg.account}:${leg.amount.currency}:${leg.amount.minor}`)
      .join(';');
    return toHex(
      await this.deps.digest.hash(
        ENCODER.encode(`${prevHash}|${request.idempotencyKey}|${legs}`),
      ),
    );
  }

  // Reads the session's journal — the source of truth — and refuses to settle over a journal
  // whose chain no longer re-derives: a tampered row must never reach a settlement posting.
  private async journal(): Promise<Movement[]> {
    const movements: Movement[] = [];
    for await (const movement of this.deps.store.movements.bySession(
      this.sessionId,
    )) {
      movements.push(movement);
    }
    let prev = GENESIS_HEX;
    for (const movement of movements) {
      const recomputed = await this.chain(prev, movement);
      if (movement.prevHash !== prev || movement.hash !== recomputed) {
        throw fault(
          ERROR_CODES.CHAIN_BROKEN,
          'The session journal failed to re-derive; refusing to settle over a tampered journal.',
          {
            retryable: false,
            detail: { sessionId: this.sessionId, seq: movement.seq },
          },
        );
      }
      prev = movement.hash;
    }
    return movements;
  }

  // One settlement chunk (or its exact compensation): the chunk's positions against clearing,
  // idempotent on the chunk txn id so a recovered settle finishes instead of double-posting.
  private async postChunk(
    chunk: ReadonlyArray<[AccountRef, bigint]>,
    at: { index: number; of: number; netted: number; journalHead: string },
    compensate = false,
  ): Promise<void> {
    const { index, of, netted, journalHead } = at;
    const txnId = compensate
      ? `net_${this.sessionId}_c${index}_comp`
      : `net_${this.sessionId}_c${index}`;
    const sign = compensate ? -1n : 1n;
    let clearing = 0n;
    const legs: Leg[] = chunk.map(([account, minor]) => {
      clearing -= minor * sign;
      return { account, amount: toAmount('CREDIT', minor * sign) };
    });
    if (clearing !== 0n) {
      legs.push({
        account: SYSTEM.NETTING_CLEARING,
        amount: toAmount('CREDIT', clearing),
      });
    }
    await this.deps.store.transaction(async (unit) => {
      if ((await unit.ledger.posting(txnId)) !== null) {
        return;
      }
      await postEntry(unit.ledger, {
        txnId,
        legs,
        meta: {
          kind: compensate
            ? 'instance_settlement_compensation'
            : 'instance_settlement',
          sessionId: this.sessionId,
          netted,
          journalHead,
          chunk: `${index + 1}/${of}`,
        },
      });
    });
  }

  // The fallback: every accepted movement becomes its own posting with its own outcome. A
  // movement the ledger refuses (funds gone since accept) is recorded as rejected — never
  // silently dropped, never partially applied.
  private async replay(
    movements: ReadonlyArray<Movement>,
    journalHead: string,
  ): Promise<SettleReport> {
    const rejected: Array<{
      idempotencyKey: string;
      reason: RejectionCode | ErrorCode;
    }> = [];
    let postings = 0;
    for (const movement of movements) {
      const txnId = `mv_${this.sessionId}_${movement.seq}`;
      try {
        await this.deps.store.transaction(async (unit) => {
          if ((await unit.ledger.posting(txnId)) !== null) {
            return; // an earlier replay attempt already posted this movement
          }
          await postEntry(unit.ledger, {
            txnId,
            legs: movement.legs,
            meta: {
              kind: 'instance_movement_replay',
              sessionId: this.sessionId,
              seq: movement.seq,
              journalHead,
            },
          });
        });
        postings += 1;
      } catch (error) {
        const reason = normalizeError(error).code;
        rejected.push({ idempotencyKey: movement.idempotencyKey, reason });
        this.remember(movement.idempotencyKey, { status: 'rejected', reason });
      }
    }
    await this.releaseReservations();
    return {
      mode: 'replayed',
      postings,
      rejected,
      journalHead,
      netted: movements.length,
    };
  }

  /** Internal recovery hook for {@link recoverSession}; not part of the public surface. */
  async __recover(): Promise<void> {
    const movements = await this.journal();
    for (const movement of movements) {
      this.accepted.push(movement);
      // A process-scoped registry died with the crashed process, so its reservations are
      // rebuilt here; a shared counter survived the crash already holding them, and re-adding
      // would double-count (see Reservations.scope).
      if (this.reservations.scope === 'process') {
        for (const leg of movement.legs) {
          if (isWalletAccount(leg.account)) {
            await this.reservations.add(leg.account, balanceDelta(leg).minor);
          }
        }
      }
      this.outcomes.set(movement.idempotencyKey, {
        status: 'accepted',
        seq: movement.seq,
      });
      this.head = movement.hash;
      this.seq = movement.seq + 1;
    }
    // Probe for settlement evidence, so a recovered session refuses new movements like a live
    // settled one, and so a later settle() finishes down the correct path. Compensation or
    // replayed-movement postings mean the netted attempt already failed over: only the replay
    // path (idempotent per-movement txn ids) can finish without double-posting or mis-reading a
    // compensated chunk as posted. A bare first-chunk posting with no compensation means a
    // netted settle completed or crashed mid-chunks; the netted path finishes that idempotently.
    const posting = (txnId: string): Promise<unknown> =>
      this.deps.store.ledger.posting(txnId);
    // Compensations post in reverse chunk order, so a crash mid-compensation can leave any
    // suffix of them; probe every chunk index (recomputable from the append-only journal).
    for (let i = 0; i < this.chunkCount(); i += 1) {
      if ((await posting(`net_${this.sessionId}_c${i}_comp`)) !== null) {
        this.settled = true;
        this.replayForced = true;
        return;
      }
    }
    for (const movement of this.accepted) {
      if ((await posting(`mv_${this.sessionId}_${movement.seq}`)) !== null) {
        this.settled = true;
        this.replayForced = true;
        return;
      }
    }
    if ((await posting(`net_${this.sessionId}_c0`)) !== null) {
      this.settled = true;
    }
  }

  // How many clearing chunks this session's net splits into — the same derivation settle uses,
  // over the same append-only journal, so recovery probes the exact ids a settle would mint.
  private chunkCount(): number {
    const net = new Map<AccountRef, bigint>();
    for (const movement of this.accepted) {
      for (const leg of movement.legs) {
        net.set(leg.account, (net.get(leg.account) ?? 0n) + leg.amount.minor);
      }
    }
    let positions = 0;
    for (const minor of net.values()) {
      if (minor !== 0n) {
        positions += 1;
      }
    }
    return Math.ceil(positions / this.chunkWidth);
  }
}

// Type-only re-exports so hosts can speak the session's language without reaching into ports.
export type { Movement, Leg, Amount, Currency };

// The instance fast lane, re-exported so the published `./netting` subpath carries the whole
// session story.
export { openInstanceEconomy, openInstanceEconomies } from '#src/instance.ts';
export type {
  InstanceEconomies,
  InstanceEconomiesOptions,
  InstanceEconomy,
  InstanceEconomyDeps,
  InstanceEconomyOptions,
  InstancePurchase,
  InstanceSettleReport,
  InstanceSweepReport,
  ProductKind,
  PurchaseOutcome,
} from '#src/instance.ts';
