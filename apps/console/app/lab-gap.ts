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
 * Everything this console needs that no `@pwngh/economy/…` door carries, in one place so the
 * debt is countable. Every other file in the app imports doors only, and `test/console-front-door.test.ts`
 * enforces that with this file as its one named exemption — pinned to the roster below, so a
 * symbol cannot join it without the gate noticing.
 *
 * This is a workaround, not a resting place. Each family below is a set of symbols the lab
 * exports publicly and no door carries; the fix is a door, not another entry here.
 *
 * Imports here are the lab's PUBLIC subpaths, never `#src/*`: the console used to reach raw
 * source, and even the escape hatch no longer does.
 */

// Family 1 — account vocabulary. Nothing behind a door can name an account, say who owns
// one, or say what currency it holds. `spendable` is the exception and comes from economy/ops.
export {
  SYSTEM,
  currency,
  earned,
  isWalletAccount,
  ownerOf,
  promo,
} from '@pwngh/economy-lab';

// Family 2 — port constructors. `EconomyModule.ports` invites an override of any of
// fifteen slots and no door carries a constructor for one of them.
export {
  configuredRates,
  flatFee,
  jsonlLogger,
  silentMeter,
  systemDigest,
  systemSigner,
} from '@pwngh/economy-lab/adapters';

// Family 3 — integrity. The full prover, the chain's genesis hash, and the hash lookup
// the ledger explorer resolves a query against.
export { findByHash, proveEconomy } from '@pwngh/economy-lab';
export { GENESIS_HEX } from '@pwngh/economy-lab/store-kit';

// Family 4 — errors. `EconomyError` is behind a door; naming a code or raising a fault
// is not, and the console's stand-in payment provider must raise a retryable provider failure.
export { ERROR_CODES, fault } from '@pwngh/economy-lab';

// Family 5 — config, and 6 — paging.
export { DEV_RATES, mergeConfig, paginate } from '@pwngh/economy-lab';

// Money arithmetic. NOT a missing door: economy/money ships Money with add/subtract/compare and
// credits/usd, so these have analogues in a class vocabulary. They stay here because translating
// them is a semantic change — the console sums wallet totals in bigint minor units on purpose, a
// total can cross 2^53 minor, and that is a separate piece of work from this migration.
export {
  add,
  convertFloor,
  encodeAmount,
  toAmount,
} from '@pwngh/economy-lab';

// Types. Every one of these has a public lab route and no door; `App.ports` and
// `App.worker` are handed back by the front door with types that cannot be named through it.
export type {
  AccountRef,
  Clock,
  Config,
  Digest,
  Dispatcher,
  Ids,
  Leg,
  Ports,
  Posting,
  ProveReport,
  RatesConfig,
  Saga,
  Store,
  Worker,
} from '@pwngh/economy-lab';
export type { PurchaseEvent } from '@pwngh/economy-lab/server';

// The in-memory ledger the integrity theater tampers with. This app used to declare the two back
// doors by hand; the lab gave the type a public route, so the two call sites narrow instead of
// casting through unknown.
export type { MemoryLedger } from '@pwngh/economy-lab/adapters';
