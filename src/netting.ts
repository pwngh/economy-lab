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
 * Per-instance netting: accept thousands of small balanced movements (tips, unlocks) into a
 * durable journal and settle the NET against the ledger when the instance closes. The journal is
 * the source of truth, never session memory — rows are hash-chained per session and the
 * settlement posting anchors the final head, so tamper-evidence extends from the proved ledger
 * to every movement. Opt-in and host-level, on purpose: per-movement enforcement moves to the
 * session (DB-final at settle) and movements bypass the submit pipeline's maturity gate.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 *   chain-and-anchor construction the journal reuses.
 */

import { GENESIS_HEX, postEntry, balanceDelta } from '#src/ledger.ts';
import { isWalletAccount, SYSTEM } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import { toHex } from '#src/bytes.ts';
import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { ErrorCode, RejectionCode } from '#src/errors.ts';
import type { Amount, Currency } from '#src/money.ts';
import type { Clock, Digest, Leg, Movement, Store } from '#src/ports.ts';

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
 * accept time, released at settle. Share ONE instance across every session in the process and the
 * cross-instance overdraft race cannot happen here; the settle replay path remains as the
 * backstop for crash-recovery windows. Multi-node needs a shared counter and a fail-closed
 * policy; this in-process registry deliberately is not that.
 */
export interface Reservations {
  pending(account: AccountRef): bigint;
  add(account: AccountRef, naturalDelta: bigint): void;
}

export function createReservations(): Reservations {
  const pending = new Map<AccountRef, bigint>();
  return {
    pending: (account) => pending.get(account) ?? 0n,
    add: (account, naturalDelta) => {
      pending.set(account, (pending.get(account) ?? 0n) + naturalDelta);
    },
  };
}

export interface SessionDeps {
  store: Store;
  digest: Digest;
  clock: Clock;
}

export interface SessionOptions {
  /** Accepted movements per journal batch; the batch commits as one insert. */
  maxBatch?: number;

  /** Max participant accounts per settlement chunk (the lock-width bound). */
  chunkWidth?: number;

  /** The shared cross-session registry; a private one still guards within this session. */
  reservations?: Reservations;
}

/**
 * Opens a netting session. `record` accepts or rejects movements (idempotent per key, affordable
 * per the reservation registry, durable per journal batch); `flush` forces the pending batch out;
 * `settle` derives the net from the journal, verifies the chain, and posts it in clearing chunks.
 *
 * `deps` is a structural subset of {@link Capabilities}, so a host composed via
 * `capabilitiesFromEnv` passes its capabilities straight through. Share ONE `reservations`
 * registry across every session in the process (see {@link Reservations}).
 *
 * @example
 *   const caps = await capabilitiesFromEnv(process.env, ports);
 *   const reservations = createReservations(); // one per process
 *   const session = instanceSession(caps, `sess_${instanceId}`, { reservations });
 *   const amount = decodeAmount('0.50', 'CREDIT');
 *   await session.record({
 *     idempotencyKey: tipId,
 *     legs: [debit(spendable(viewerId), amount), credit(earned(creatorId), amount)],
 *   });
 *   await session.settle(); // at instance close
 */
export function instanceSession(
  deps: SessionDeps,
  sessionId: string,
  options?: SessionOptions,
): InstanceSession {
  return new InstanceSession(deps, sessionId, options);
}

/**
 * Rebuilds a session from its journal — the crash-recovery path. Outcomes, the running net, and
 * the chain head all re-derive from the journal rows; a rebuilt session can keep recording or go
 * straight to settle, and settle keying each chunk on its posting's existence makes a half-settled
 * session finish rather than double-post.
 */
export async function recoverSession(
  deps: SessionDeps,
  sessionId: string,
  options?: SessionOptions,
): Promise<InstanceSession> {
  const session = new InstanceSession(deps, sessionId, options);
  await session.__recover();
  return session;
}

export class InstanceSession {
  private readonly deps: SessionDeps;
  private readonly sessionId: string;
  private readonly maxBatch: number;
  private readonly chunkWidth: number;
  private readonly reservations: Reservations;

  private readonly outcomes = new Map<string, MovementOutcome>();
  private readonly accepted: Movement[] = []; // every accepted movement, in seq order
  private pending: Movement[] = []; //           accepted but not yet journaled
  private readonly opening = new Map<AccountRef, bigint>(); // first-touch balance reads
  private head = GENESIS_HEX;
  private seq = 0;

  constructor(deps: SessionDeps, sessionId: string, options?: SessionOptions) {
    this.deps = deps;
    this.sessionId = sessionId;
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
    const replay = this.outcomes.get(request.idempotencyKey);
    if (replay) {
      return replay;
    }

    const rejection = await this.screen(request.legs);
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
    this.apply(movement.legs, 1n);
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
      return this.replay(movements, head);
    }

    this.releaseReservations();
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
  private async screen(
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
    for (const leg of legs) {
      if (!isWalletAccount(leg.account)) {
        continue;
      }
      const delta = balanceDelta(leg).minor;
      if (delta >= 0n) {
        continue;
      }
      const opening = await this.openingBalance(leg.account);
      if (opening + this.reservations.pending(leg.account) + delta < 0n) {
        return 'INSUFFICIENT_FUNDS';
      }
    }
    return null;
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

  // Applies a movement's natural deltas to the shared reservation registry (sign +1) or backs
  // them out (-1). Only wallet accounts are guarded; platform accounts absorb any sign.
  private apply(legs: ReadonlyArray<Leg>, sign: 1n | -1n): void {
    for (const leg of legs) {
      if (isWalletAccount(leg.account)) {
        this.reservations.add(leg.account, balanceDelta(leg).minor * sign);
      }
    }
  }

  private released = false;

  // Idempotent on purpose: a re-settled session (recovery, or a caller retrying) must not drive
  // the shared registry negative by releasing the same reservations twice.
  private releaseReservations(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    for (const movement of this.accepted) {
      for (const leg of movement.legs) {
        if (isWalletAccount(leg.account)) {
          this.reservations.add(leg.account, -balanceDelta(leg).minor);
        }
      }
    }
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
    this.releaseReservations();
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
      this.apply(movement.legs, 1n);
      this.outcomes.set(movement.idempotencyKey, {
        status: 'accepted',
        seq: movement.seq,
      });
      this.head = movement.hash;
      this.seq = movement.seq + 1;
    }
  }
}

// Type-only re-exports so hosts can speak the session's language without reaching into ports.
export type { Movement, Leg, Amount, Currency };
