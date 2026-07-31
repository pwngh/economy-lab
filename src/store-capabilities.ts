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
 * Resolves which optional surfaces a store actually offers, so the conformance suite can branch
 * on a roster instead of on `undefined` checks buried in its test bodies.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the Store
 *   port and the conformance suite every implementation is held to.
 */

import type { Store, StoreCapability, Unit } from '#src/ports.ts';

/**
 * Every optional surface the conformance suite branches on, in one place.
 *
 * A short roster is the failure mode worth guarding: a capability the suite forgets to name is a
 * surface nothing branches on, which is how a test body comes to return early and report success.
 * `test/conformance-contract.test.ts` pins the length and cross-checks each name against a real
 * `?` member of {@link ports!Store}.
 *
 * That cross-check is also the roster's boundary, and it is the answer to a question asked twice:
 * whether two transactions can overlap is not a capability and cannot become one. Nothing on
 * {@link ports!Store} is present or absent according to it, so {@link capabilitiesOf} — which
 * resolves by looking at members — has nothing to look at, and any entry standing in for it would
 * be a proxy. `lockMany` is the near miss: it resolves whether a ledger method exists, not whether
 * two writers can be in flight. So a case needing genuine overlap is gated on the capability whose
 * own semantics require it, and asserts the overlap it observed rather than assuming it.
 */
export const STORE_CAPABILITIES: readonly StoreCapability[] = [
  'appendAll',
  'archive',
  'batchTransaction',
  'historySize',
  'idempotencyRetention',
  'journalRetention',
  'journalSessionIds',
  'lockMany',
  'reproof',
  'reservations',
  'sealHeads',
  'tableSizes',
];

// Ledger surfaces resolve against whichever ledger the caller is holding; the rest hang off the
// store. `archive` spans both halves of the mover — the page read, the prune, and the signed
// boundary it writes through — because a store offering only some of them cannot host it.
const PRESENCE: Record<
  StoreCapability,
  (store: Store, ledger: Store['ledger']) => boolean
> = {
  appendAll: (_store, ledger) => ledger.appendAll !== undefined,
  archive: (store, ledger) =>
    ledger.archivePage !== undefined &&
    ledger.prune !== undefined &&
    store.checkpoints.archiveState !== undefined &&
    store.checkpoints.putArchiveBoundary !== undefined &&
    store.checkpoints.archiveHeads !== undefined,
  batchTransaction: (store) => store.batchTransaction !== undefined,
  historySize: (_store, ledger) => ledger.historySize !== undefined,
  idempotencyRetention: (store) =>
    store.idempotency.deleteOlderThan !== undefined,
  journalRetention: (store) => store.movements.pruneSession !== undefined,
  journalSessionIds: (store) => store.movements.sessionIds !== undefined,
  lockMany: (_store, ledger) => ledger.lockMany !== undefined,
  reproof: (store) =>
    store.checkpoints.reproof !== undefined &&
    store.checkpoints.putReproof !== undefined,
  reservations: (store) => store.reservations !== undefined,
  sealHeads: (store) =>
    store.checkpoints.sealHeads !== undefined &&
    store.checkpoints.putSealHeads !== undefined,
  tableSizes: (store) => store.tableSizes !== undefined,
};

/**
 * What this store offers right now, derived by looking rather than by asking.
 *
 * Pass the `unit` from an open transaction. Ledger capabilities resolve against it, because the
 * transaction unit is the only place locking means anything and the two levels genuinely
 * disagree: Postgres carries `lockMany` on `unit.ledger` and not on `store.ledger`. Without a
 * unit the store-level ledger answers, which reports that Postgres cannot lock.
 */
export function capabilitiesOf(
  store: Store,
  unit?: Unit,
): Record<StoreCapability, boolean> {
  const ledger = unit?.ledger ?? store.ledger;
  const resolved = {} as Record<StoreCapability, boolean>;
  for (const capability of STORE_CAPABILITIES) {
    resolved[capability] = PRESENCE[capability](store, ledger);
  }
  return resolved;
}

/**
 * Where a store's own account of itself disagrees with what it actually carries, one message per
 * capability, empty when they agree.
 *
 * Presence is not proof and a declaration is not either, so the suite takes neither on trust. A
 * store that names `lockMany` in its declaration and reaches the transaction unit without one is
 * the case this exists for: the member is right there on `store.ledger`, the author believes it
 * ships, and every call inside a transaction silently takes the per-account fallback.
 */
export function capabilityConflicts(
  resolved: Record<StoreCapability, boolean>,
  declared: Partial<Record<StoreCapability, boolean>>,
): string[] {
  const conflicts: string[] = [];
  for (const capability of STORE_CAPABILITIES) {
    const claim = declared[capability];
    if (claim !== undefined && claim !== resolved[capability]) {
      conflicts.push(
        `${capability}: declared ${claim}, but the store resolves ${resolved[capability]}`,
      );
    }
  }
  return conflicts;
}
