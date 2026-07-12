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

import { compose } from '@pwngh/economy-edge';
import { tilia } from '@pwngh/economy-edge/providers/outbound/tilia';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { toAmount } from '#src/money.ts';

import type { EdgeOutbound } from '@pwngh/economy-edge';
import type { RawWebhook } from '@pwngh/economy-edge/ports';
import type { TiliaConfig } from '@pwngh/economy-edge/providers/outbound/tilia';
import type { PayeeDirectory, Processor } from '#src/ports.ts';
import type { FloatFeed } from '#src/worker/treasury.ts';

export function edgeTiliaProcessor(outbound: EdgeOutbound): Processor {
  return {
    submitPayout: async (input) => {
      const result = await outbound.submit({
        key: input.key,
        payee: input.userId,
        amount: input.amount,
      });
      if (result.outcome === 'ACCEPTED') {
        return { providerRef: result.ref.id };
      }
      if (result.outcome === 'INDETERMINATE') {
        throw fault(
          ERROR_CODES.PROVIDER_FAILURE,
          'The payout rail left the submit indeterminate; re-drive with the same key.',
          { retryable: true, detail: { key: input.key } },
        );
      }
      throw fault(
        ERROR_CODES.PROVIDER_FAILURE,
        'The payout rail rejected the submit.',
        { detail: { key: input.key, reason: result.reason } },
      );
    },

    payoutStatus: async (input) => {
      const status = await outbound.status({
        ref: { provider: 'tilia', id: input.providerRef },
      });
      return { state: status.state };
    },
  };
}

export function edgeTiliaPayees(outbound: EdgeOutbound): PayeeDirectory {
  return {
    status: async (userId) => {
      const status = await outbound.payee.status({ userId });
      return { state: status.state };
    },
  };
}

export function edgeTiliaFloat(outbound: EdgeOutbound): FloatFeed {
  return {
    balance: async () => {
      const balance = await outbound.balance();
      // The float sweep compares this against USD trust maths; a balance in any other
      // currency must fail here, not be silently relabeled as dollars.
      if (balance.currency !== 'USD') {
        throw fault(
          ERROR_CODES.PROVIDER_FAILURE,
          'The payout rail reported a wallet balance in a non-USD currency.',
          { detail: { currency: balance.currency } },
        );
      }
      return toAmount('USD', balance.minor);
    },
  };
}

export function payoutMatchKeyOf(providerRef: string): string {
  const separator = providerRef.lastIndexOf('/');
  return separator < 0 ? providerRef : providerRef.slice(separator + 1);
}

export interface EdgeTiliaCapabilities {
  readonly processor: Processor;
  readonly payees: PayeeDirectory;
  readonly float: FloatFeed;
  readonly outbound: EdgeOutbound;
  verifyWebhook(webhook: RawWebhook): Promise<boolean>;
}

export function edgeTiliaCapabilities(
  config: TiliaConfig,
): EdgeTiliaCapabilities {
  const { outbound } = compose({ outbound: [tilia(config)] });
  return {
    processor: edgeTiliaProcessor(outbound),
    payees: edgeTiliaPayees(outbound),
    float: edgeTiliaFloat(outbound),
    outbound,
    verifyWebhook: (webhook) => outbound.verify(webhook),
  };
}
