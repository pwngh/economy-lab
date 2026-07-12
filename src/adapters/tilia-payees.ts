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

// The durable Tilia payee directory: one row per lab user carrying the
// routing ids Tilia's hosted onboarding minted. Production resolves payees
// here instead of the TILIA_PAYEE_MAP env JSON, which stays as the dev-shaped
// fallback. psql is the admin UI:
//
//   insert into tilia_payees
//     (user_id, account_id, source_payment_method_id, destination_payment_method_id)
//   values ('usr_1', 'acct-…', 'pm-…', 'pm-…')
//   on conflict (user_id) do update
//     set account_id = excluded.account_id,
//         source_payment_method_id = excluded.source_payment_method_id,
//         destination_payment_method_id = excluded.destination_payment_method_id,
//         updated_at = now();

import type { TiliaPayee } from '@pwngh/economy-edge/providers/outbound/tilia';

/** The one query method the store needs; a pg pool or client satisfies it. */
export interface PayeeDb {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface TiliaPayeeStore {
  ensureSchema(): Promise<void>;
  resolve(userId: string): Promise<TiliaPayee>;
}

const DDL = `
create table if not exists tilia_payees (
  user_id                       text        primary key,
  account_id                    text        not null,
  source_payment_method_id      text        not null,
  destination_payment_method_id text        not null,
  updated_at                    timestamptz not null default now()
)`;

export function tiliaPayeeStore(db: PayeeDb): TiliaPayeeStore {
  return {
    ensureSchema: async () => {
      await db.query(DDL);
    },
    resolve: async (userId) => {
      const result = await db.query(
        `select account_id, source_payment_method_id, destination_payment_method_id
           from tilia_payees where user_id = $1`,
        [userId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(
          `no tilia_payees row for ${userId}; insert one (see src/adapters/tilia-payees.ts for the statement)`,
        );
      }
      return {
        accountId: String(row.account_id),
        sourcePaymentMethodId: String(row.source_payment_method_id),
        destinationPaymentMethodId: String(row.destination_payment_method_id),
      };
    },
  };
}
