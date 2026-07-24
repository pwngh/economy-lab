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

// The multi-node construction (documented on openClusterNode and ClusterNodeOptions). The
// pieces stay individually exported; single-node hosts need none of this.

import { scopeRouter } from '#src/router.ts';
import {
  epochMinter,
  openInstanceSession,
  recoverSession,
  sharedReservations,
} from '#src/netting.ts';
import { sweepOrphanSessions } from '#src/worker/orphans.ts';
import { DEFAULT_EPOCH_MAX_AGE_MS } from '#src/instance.ts';
import { silentLogger, silentMeter } from '#src/runtime.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';

import type {
  InstanceSession,
  Reservations,
  SessionOptions,
} from '#src/netting.ts';
import type { OrphanSweepSummary } from '#src/worker/orphans.ts';
import type { Clock, Digest, Ids, Logger, Meter, Store } from '#src/ports.ts';

/** The structural subset of Ports a cluster node needs; an openPorts host passes through. */
export interface ClusterNodeDeps {
  store: Store;
  digest: Digest;
  clock: Clock;
  ids: Ids;
  logger?: Logger;
  meter?: Meter;
}

/**
 * The node's identity and peers, plus the two bounds the epoch-age law binds together: every
 * epoch on this node rotates within `epochMaxAgeMs`, and a due rotation is only observed a
 * sweep cadence later, so the orphan sweep settles nothing younger than twice that bound.
 * Construction throws CONFIG_INVALID on a `settleOlderThanMs` under `2 * epochMaxAgeMs` — a
 * lower bound would let the sweep settle an epoch a live node could still be filling.
 */
export interface ClusterNodeOptions {
  /** This node's name; must appear in `nodes`. */
  nodeId: string;

  /** Every node in the deployment. All nodes must construct from the same list. */
  nodes: ReadonlyArray<string>;

  /**
   * The rotation bound every epoch on this node lives under — the lane manager's
   * `epochMaxAgeMs` when lanes run here (see `laneOptions`), the host's own rotation cadence
   * for raw sessions. Default 60_000 ms.
   */
  epochMaxAgeMs?: number;

  /**
   * Orphan settling opt-in (settling moves money). Absent, `sweepOrphans` still reports
   * crashed epochs; it settles nothing.
   */
  sweep?: {
    /**
     * The sweep settles sessions at least this old (ms). Held to the epoch-age law: at least
     * `2 * epochMaxAgeMs`, enforced at construction.
     */
    settleOlderThanMs: number;

    /** Max sessions inspected per sweep run. Default 100. */
    limit?: number;
  };
}

/**
 * Opens this process's node of a multi-node deployment — one construction for what every
 * multi-node host was hand-wiring: the scope router bound to this node's identity, the
 * store-backed shared reservation registry, ownership-gated session opening, crash recovery,
 * and the orphan sweep. Every node constructs from the same `nodes` list over the same shared
 * database, and the store must offer the reservation counter (the SQL engines and the memory
 * adapter all do).
 *
 * @example
 * const node = openClusterNode(ports, {
 *   nodeId: 'economy-a',
 *   nodes: ['economy-a', 'economy-b', 'economy-c'],
 *   sweep: { settleOlderThanMs: 120_000 },
 * });
 * const lanes = openInstanceEconomies(ports, { ...node.laneOptions() });
 *
 * // Per request from a game server:
 * node.assertOwns(worldInstanceId);
 * await lanes.laneFor(worldInstanceId).purchase(order);
 *
 * // On the worker's schedule:
 * await node.sweepOrphans();
 */
export function openClusterNode(
  deps: ClusterNodeDeps,
  options: ClusterNodeOptions,
): ClusterNode {
  return new ClusterNode(deps, options);
}

/**
 * One node's handle. `ownerOf`/`owns`/`assertOwns` answer the shared rendezvous assignment;
 * `openSession` opens ownership-gated epochs; `recover` finishes a crashed node's session;
 * `laneOptions` spreads into the lane manager; `sweepOrphans` runs the shared-journal sweep.
 * Construct through {@link openClusterNode}.
 */
export class ClusterNode {
  readonly nodeId: string;

  /**
   * The store-backed registry every session on this node screens against. Pass it wherever a
   * registry is asked for (the worker's orphans job, a lane manager not built from
   * `laneOptions`); never build a second one per node.
   */
  readonly reservations: Reservations;

  private readonly deps: ClusterNodeDeps;
  private readonly route: (scope: string) => string;
  private readonly epochMaxAgeMs: number;
  private readonly sweep: ClusterNodeOptions['sweep'];
  private readonly mint: (scope: string) => string;

  constructor(deps: ClusterNodeDeps, options: ClusterNodeOptions) {
    if (!options.nodes.includes(options.nodeId)) {
      throw fault(
        ERROR_CODES.CONFIG_INVALID,
        'A cluster node must appear in its own node list.',
        {
          retryable: false,
          detail: { nodeId: options.nodeId, nodes: [...options.nodes] },
        },
      );
    }
    this.epochMaxAgeMs = options.epochMaxAgeMs ?? DEFAULT_EPOCH_MAX_AGE_MS;
    if (
      options.sweep !== undefined &&
      options.sweep.settleOlderThanMs < 2 * this.epochMaxAgeMs
    ) {
      throw fault(
        ERROR_CODES.CONFIG_INVALID,
        'sweep.settleOlderThanMs must be at least twice epochMaxAgeMs; a lower bound lets the sweep settle an epoch a live node could still be filling.',
        {
          retryable: false,
          detail: {
            settleOlderThanMs: options.sweep.settleOlderThanMs,
            epochMaxAgeMs: this.epochMaxAgeMs,
          },
        },
      );
    }
    this.deps = deps;
    this.nodeId = options.nodeId;
    this.route = scopeRouter(options.nodes);
    this.reservations = sharedReservations(deps.store);
    this.sweep = options.sweep;
    this.mint = epochMinter(deps.ids);
  }

  /** The scope's owning node per the rendezvous assignment — the same answer on every node. */
  ownerOf(scope: string): string {
    return this.route(scope);
  }

  /** Whether the assignment routes the scope here; the boolean form of {@link ClusterNode.ownerOf}. */
  owns(scope: string): boolean {
    return this.route(scope) === this.nodeId;
  }

  /** Throws SESSION_MISROUTED unless this node owns the scope — the gate for a request edge. */
  assertOwns(scope: string): void {
    const owner = this.route(scope);
    if (owner !== this.nodeId) {
      throw fault(
        ERROR_CODES.SESSION_MISROUTED,
        'This node does not own the scope; send its traffic to the owner.',
        {
          retryable: false,
          detail: { scope, owner, nodeId: this.nodeId },
        },
      );
    }
  }

  /**
   * Opens the scope's next raw netting epoch: ownership-gated, screened by the shared
   * registry, session id minted as `sess:<scope>:<nonce>-<n>`. The caller owes the epoch
   * discipline — settle within `epochMaxAgeMs`, then open the next epoch (the lane manager
   * does both on cadence; see `laneOptions`).
   */
  openSession(
    scope: string,
    options?: Omit<SessionOptions, 'reservations'>,
  ): InstanceSession {
    this.assertOwns(scope);
    return openInstanceSession(this.deps, this.mint(scope), {
      ...(options ?? {}),
      reservations: this.reservations,
    });
  }

  /**
   * Rebuilds a journaled session with the shared registry wired in — the failover path for a
   * session id the sweep reported. The shared counter already holds the crashed node's
   * reservations, and wiring the registry here is what tells recovery not to re-apply them.
   */
  recover(sessionId: string): Promise<InstanceSession> {
    return recoverSession(this.deps, sessionId, {
      reservations: this.reservations,
    });
  }

  /**
   * Spread into `openInstanceEconomies` so the manager's lanes share this node's registry and
   * rotate under the same bound the sweep law was validated against.
   */
  laneOptions(): { reservations: Reservations; epochMaxAgeMs: number } {
    return {
      reservations: this.reservations,
      epochMaxAgeMs: this.epochMaxAgeMs,
    };
  }

  /**
   * One orphan-sweep pass over the shared journal: reports crashed epochs, settles the ones
   * older than the validated bound when the `sweep` opt-in is set, and releases their
   * reservations. Schedule it like any worker sweep; more than one node running it is safe
   * (settling is idempotent against stored evidence).
   */
  sweepOrphans(input?: {
    now?: number;
    limit?: number;
  }): Promise<OrphanSweepSummary> {
    return sweepOrphanSessions(
      this.deps.store,
      {
        clock: this.deps.clock,
        digest: this.deps.digest,
        logger: this.deps.logger ?? silentLogger(),
        meter: this.deps.meter ?? silentMeter(),
      },
      {
        now: input?.now ?? this.deps.clock.now(),
        limit: input?.limit ?? this.sweep?.limit ?? 100,
        ...(this.sweep === undefined
          ? {}
          : { settleOlderThanMs: this.sweep.settleOlderThanMs }),
        reservations: this.reservations,
      },
    );
  }
}
