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

// The one edit that moves a stored posting's chain hash and nothing else. Every other reachable
// tamper is either invisible to the hash or lands as balance drift, so a test that wants to break
// `chainIntact` alone uses this and no second construction.

import { toAmount } from '#src/money.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { Leg } from '#src/ports.ts';

/**
 * Re-cuts one account's leg of a recorded posting into two legs that add to the same figure.
 *
 * `chainPreimage` filters a link to the account's own legs and sorts them by encoded amount, so
 * reordering hashes the same and editing an amount shows up as drift against the cached balance.
 * Splitting one leg in two moves that account's link preimage while its balance, its derived sum
 * and the ledger's conservation total all stay exactly where they were. The link is rewritten
 * under its recorded hash, which is the corruption a chain replay exists to find.
 *
 * Throws when the posting carries no leg for `account`, or when the leg is too small to split,
 * so a book that stopped containing what the caller thought fails here instead of proving less.
 */
export function recutLeg(
  ledger: MemoryLedger,
  txnId: string,
  account: AccountRef,
): void {
  let recut = false;
  ledger.__tamper(txnId, (legs: Leg[]) => {
    const at = legs.findIndex((leg) => leg.account === account);
    if (at === -1) {
      return;
    }
    const { currency, minor } = legs[at]!.amount;
    if (minor > -2n && minor < 2n) {
      throw new Error(
        `recutLeg: ${account}'s leg of ${txnId} is ${minor} minor units and cannot split into two nonzero legs`,
      );
    }
    const sliver = minor > 0n ? 1n : -1n;
    legs.splice(
      at,
      1,
      { account, amount: toAmount(currency, minor - sliver) },
      { account, amount: toAmount(currency, sliver) },
    );
    recut = true;
  });
  if (!recut) {
    throw new Error(`recutLeg: no leg for ${account} in posting ${txnId}`);
  }
}
