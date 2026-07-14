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
 * The slice of the console facade a docs snippet drives. The runner passes the real engine
 * (apps/console/app/economy.ts buildEngine), so what a snippet shows is what the console does —
 * and the same calls replay there through the journal handoff.
 */

export interface SnippetOutcome {
  status: 'committed' | 'duplicate' | 'rejected';
  transaction?: { id: string };
  reason?: string;
  // Typed figures a rejection carries (amounts encoded "CREDIT:12.34" / "USD:1.00").
  detail?: Record<string, unknown>;
}

export interface SnippetCtx {
  deposit(input: { userId: string; credits: number }): Promise<SnippetOutcome>;
  purchase(input: {
    buyerId: string;
    sellerId: string;
    listing: string;
    credits: number;
    orderId?: string;
  }): Promise<SnippetOutcome>;
  requestPayout(input: {
    userId: string;
    credits: number;
  }): Promise<SnippetOutcome>;
  drainWallet(input: {
    buyerId: string;
    sellerId: string;
    listing: string;
    credits: number;
    count: number;
  }): Promise<{
    attempts: number;
    committed: number;
    insufficient: number;
    movedCredits: number;
  }>;
  setVelocityLimit(credits: number): Promise<void>;
  // The thorough prover: hashes and balances re-derived from the raw lines, not the light
  // shape check the console chrome polls.
  proveFull(): Promise<{
    conserved: boolean;
    backed: boolean;
    noOverdraft: boolean;
    chainIntact: boolean;
    consistent: boolean;
    allGreen: boolean;
  }>;
}

/**
 * What a run reports back: the lines the page prints, plus where the console handoff link lands —
 * a posting to drill into, or a console page path like '/integrity'.
 */
export interface SnippetReport {
  lines: string[];
  txnId?: string;
  consolePath?: string;
}
