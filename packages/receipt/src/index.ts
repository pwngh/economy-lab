/**
 * @pwngh/economy-receipt
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

export { createReceipts, Receipts } from './lib/receipt.js';
export type {
  LedgerTransaction,
  Receipt,
  ReceiptLeg,
  ReceiptLink,
  ReceiptsOptions,
} from './lib/receipt.js';
// Never re-exported: sign, unsign, and keyId from ./lib/receipt-signing.js. The HMAC is how the
// operations above keep their promise, not a signing service for callers to reach past them.
