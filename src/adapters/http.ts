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
 * Client half of the HTTP storage backend: a Store whose every call becomes an HTTP request
 * answered by a server handler (http-server.ts). Amounts cross the wire as decimal strings
 * because JSON cannot carry a bigint.
 */

import { ERROR_CODES, EconomyError } from '#src/errors.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { decodeWire, encodeWire } from '#src/adapters/http-wire.ts';
import { createStoreServer } from '#src/adapters/http-server.ts';

import type { ErrorCode } from '#src/errors.ts';
import type { AccountRef } from '#src/accounts.ts';
import type {
  Checkpoint,
  Lot,
  MovementJournal,
  Options,
  OutboxMessage,
  OutboxStats,
  Posting,
  StoredLink,
  Store,
  Unit,
  CheckpointStore,
  EntitlementStore,
  IdempotencyStore,
  InboxStore,
  Ledger,
  OutboxStore,
  PromoStore,
  ReplayStore,
  SagaStore,
  SaleStore,
  SubscriptionStore,
  TimelineOptions,
  TrustStore,
} from '#src/ports.ts';

export type FetchLike = (request: Request) => Promise<Response>;

export type HttpStoreOptions = {
  fetch?: FetchLike;

  baseUrl?: string;
};

type Transport = { fetch: FetchLike; baseUrl: string };

// Every response body: a result, or a failure the client rebuilds into an equivalent
// EconomyError — same stable code, same retryable verdict — so it fails like an in-process call.
type WireResult =
  | { ok: true; body: unknown }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

// An unknown code (a newer or older server) degrades to a retryable STORE.FAILURE rather than
// being trusted verbatim.
const KNOWN_CODES = new Set<string>(Object.values(ERROR_CODES));

function rebuildError(wire: {
  code: string;
  message: string;
  retryable: boolean;
}): EconomyError {
  if (KNOWN_CODES.has(wire.code)) {
    return new EconomyError(wire.code as ErrorCode, wire.message, {
      retryable: wire.retryable,
    });
  }
  return new EconomyError(ERROR_CODES.STORE_FAILURE, wire.message, {
    retryable: true,
  });
}

// --- The transport call -----------------------------------------------------------

async function call(
  transport: Transport,
  path: string,
  payload: unknown,
  options?: Options,
): Promise<unknown> {
  const request = new Request(new URL(path, transport.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options?.signal,
  });
  const response = await transport.fetch(request);
  const result = (await response.json()) as WireResult;
  if (!result.ok) {
    throw rebuildError(result.error);
  }
  return result.body;
}

// --- The ledger, scoped to one transaction ----------------------------------------

// A transaction lives on the server as a "session"; every request path carries its id. The id
// 'root' means "not in a transaction": each such call runs on its own.
function sessionLedger(transport: Transport, session: string): Ledger {
  const at = (method: string): string => `/tx/${session}/ledger/${method}`;
  return {
    hasAccount: (account, options) =>
      call(
        transport,
        at('hasAccount'),
        { account },
        options,
      ) as Promise<boolean>,
    lock: async (account, options) => {
      await call(transport, at('lock'), { account }, options);
    },
    append: async (posting, options) =>
      decodeWire.transaction(
        await call(
          transport,
          at('append'),
          encodeWire.posting(posting),
          options,
        ),
      ),
    balance: async (account, options) =>
      decodeWire.amount(
        await call(transport, at('balance'), { account }, options),
      ),
    posting: async (txnId, options) => {
      const row = await call(transport, at('posting'), { txnId }, options);
      return row === null ? null : decodeWire.posting(row);
    },
    statement: async (account, range, options) =>
      decodeWire.statement(
        await call(transport, at('statement'), { account, range }, options),
      ),
    derivedBalances: async (account, options) =>
      (
        (await call(
          transport,
          at('derivedBalances'),
          { account },
          options,
        )) as unknown[]
      ).map((row) => decodeWire.amount(row)),
    timeline: (account, options) =>
      streamLots(transport, account, session, options),
    heads: () => streamHeads(transport, session),
    headSums: () => streamHeadSums(transport, session),
    balanceAccounts: (options) =>
      streamBalanceAccounts(transport, session, options),
    lineage: (account, options) =>
      streamLineage(transport, account, session, options),
    list: (options) => streamPostings(transport, session, options),
  };
}

// --- Streamed reads ---------------------------------------------------------------

async function* streamHeads(
  transport: Transport,
  session: string,
): AsyncIterable<readonly [AccountRef, string]> {
  const rows = (await call(
    transport,
    `/tx/${session}/ledger/heads`,
    {},
  )) as Array<[string, string]>;
  for (const [account, head] of rows) {
    yield [account as AccountRef, head] as const;
  }
}

async function* streamHeadSums(
  transport: Transport,
  session: string,
): AsyncIterable<readonly [AccountRef, string, bigint]> {
  const rows = (await call(
    transport,
    `/tx/${session}/ledger/headSums`,
    {},
  )) as Array<[string, string, string]>;
  for (const [account, head, sum] of rows) {
    yield [account as AccountRef, head, BigInt(sum)] as const;
  }
}

async function* streamBalanceAccounts(
  transport: Transport,
  session: string,
  options?: Options,
): AsyncIterable<AccountRef> {
  const rows = (await call(
    transport,
    `/tx/${session}/ledger/balanceAccounts`,
    {},
    options,
  )) as string[];
  for (const account of rows) {
    yield account as AccountRef;
  }
}

async function* streamLots(
  transport: Transport,
  account: AccountRef,
  session: string,
  options?: TimelineOptions,
): AsyncIterable<Lot> {
  const rows = (await call(transport, `/tx/${session}/ledger/timeline`, {
    account,
    order: options?.order,
    limit: options?.limit,
    offset: options?.offset,
  })) as unknown[];
  for (const row of rows) {
    yield decodeWire.lot(row);
  }
}

async function* streamLineage(
  transport: Transport,
  account: AccountRef,
  session: string,
  options?: Options,
): AsyncIterable<StoredLink> {
  const rows = (await call(
    transport,
    `/tx/${session}/ledger/lineage`,
    { account },
    options,
  )) as unknown[];
  for (const row of rows) {
    yield decodeWire.storedLink(row);
  }
}

async function* streamPostings(
  transport: Transport,
  session: string,
  options?: Options,
): AsyncIterable<Posting> {
  const rows = (await call(
    transport,
    `/tx/${session}/ledger/list`,
    {},
    options,
  )) as unknown[];
  for (const row of rows) {
    yield decodeWire.posting(row);
  }
}

// --- The sub-stores, scoped to one transaction ------------------------------------

function sessionIdempotency(
  transport: Transport,
  session: string,
): IdempotencyStore {
  const at = (method: string): string => `/tx/${session}/idempotency/${method}`;
  return {
    claim: async (key, options) =>
      decodeWire.claim(await call(transport, at('claim'), { key }, options)),
    record: async (key, transaction, options) => {
      await call(
        transport,
        at('record'),
        { key, transaction: encodeWire.transaction(transaction) },
        options,
      );
    },
  };
}

function sessionSales(transport: Transport, session: string): SaleStore {
  const at = (method: string): string => `/tx/${session}/sales/${method}`;
  return {
    put: async (sale, options) => {
      await call(
        transport,
        at('put'),
        { sale: encodeWire.sale(sale) },
        options,
      );
    },
    get: async (orderId, options) => {
      const row = await call(transport, at('get'), { orderId }, options);
      return row === null ? null : decodeWire.sale(row);
    },
  };
}

function sessionOutbox(transport: Transport, session: string): OutboxStore {
  const at = (method: string): string => `/tx/${session}/outbox/${method}`;
  return {
    enqueue: async (message, options) => {
      await call(transport, at('enqueue'), { message }, options);
    },
    claimBatch: (limit, options) =>
      call(transport, at('claimBatch'), { limit }, options) as Promise<
        ReadonlyArray<OutboxMessage>
      >,
    markRelayed: async (ids, options) => {
      await call(transport, at('markRelayed'), { ids }, options);
    },
    recordFailure: async (id, options) => {
      await call(transport, at('recordFailure'), { id }, options);
    },
    deadLetter: async (id, reason, options) => {
      await call(transport, at('deadLetter'), { id, reason }, options);
    },
    stats: (options) =>
      call(transport, at('stats'), {}, options) as Promise<OutboxStats>,
  };
}

function sessionInbox(transport: Transport, session: string): InboxStore {
  const at = (method: string): string => `/tx/${session}/inbox/${method}`;
  return {
    enqueueInbound: async (entry, options) =>
      decodeWire.inboxEntry(
        await call(
          transport,
          at('enqueueInbound'),
          { entry: encodeWire.inboxEntry(entry) },
          options,
        ),
      ),
    claimInbound: async (input, options) =>
      (
        (await call(transport, at('claimInbound'), input, options)) as unknown[]
      ).map(decodeWire.inboxEntry),
    markApplied: async (id, options) => {
      await call(transport, at('markApplied'), { id }, options);
    },
    bumpAttempt: async (id, options) => {
      await call(transport, at('bumpAttempt'), { id }, options);
    },
    deadLetter: async (id, reason, options) => {
      await call(transport, at('deadLetter'), { id, reason }, options);
    },
    reviveDead: async (limit, options) =>
      (
        (await call(
          transport,
          at('reviveDead'),
          { limit },
          options,
        )) as unknown[]
      ).map(decodeWire.inboxEntry),
  };
}

function sessionSagas(transport: Transport, session: string): SagaStore {
  const at = (method: string): string => `/tx/${session}/sagas/${method}`;
  return {
    open: async (saga, options) => {
      await call(
        transport,
        at('open'),
        { saga: encodeWire.saga(saga) },
        options,
      );
    },
    load: async (id, options) => {
      const row = await call(transport, at('load'), { id }, options);
      return row === null ? null : decodeWire.saga(row);
    },
    findByProviderRef: async (providerRef, options) => {
      const row = await call(
        transport,
        at('findByProviderRef'),
        { providerRef },
        options,
      );
      return row === null ? null : decodeWire.saga(row);
    },
    list: async function* (options) {
      const rows = (await call(
        transport,
        at('list'),
        {},
        options,
      )) as unknown[];
      for (const row of rows) {
        yield decodeWire.saga(row);
      }
    },
    claimDue: async (now, limit, options) => {
      const rows = (await call(
        transport,
        at('claimDue'),
        { now, limit },
        options,
      )) as unknown[];
      return rows.map(decodeWire.saga);
    },
    // Omits the optional `options`: a caller's cancellation signal is silently dropped here.
    advance: (id, from, to, patch) =>
      call(transport, at('advance'), {
        id,
        from,
        to,
        patch: encodeWire.sagaPatch(patch),
      }) as Promise<boolean>,
    deadLetter: async (id, reason, options) => {
      await call(transport, at('deadLetter'), { id, reason }, options);
    },
    lastPayoutAt: (userId, options) =>
      call(transport, at('lastPayoutAt'), { userId }, options) as Promise<
        number | null
      >,
  };
}

function sessionEntitlements(
  transport: Transport,
  session: string,
): EntitlementStore {
  const at = (method: string): string =>
    `/tx/${session}/entitlements/${method}`;
  return {
    grant: async (userId, sku, attrs, options) => {
      await call(transport, at('grant'), { userId, sku, attrs }, options);
    },
    revoke: async (userId, sku, options) => {
      await call(transport, at('revoke'), { userId, sku }, options);
    },
    owns: (userId, sku, options) =>
      call(transport, at('owns'), { userId, sku }, options) as Promise<boolean>,
    list: async function* (userId, options) {
      const grants = (await call(
        transport,
        at('list'),
        { userId },
        options,
      )) as Array<{ sku: string; expiresAt: number | null }>;
      yield* grants;
    },
  };
}

function sessionSubscriptions(
  transport: Transport,
  session: string,
): SubscriptionStore {
  const at = (method: string): string =>
    `/tx/${session}/subscriptions/${method}`;
  return {
    open: async (sub, options) => {
      await call(
        transport,
        at('open'),
        { sub: encodeWire.subscription(sub) },
        options,
      );
    },
    load: async (id, options) => {
      const row = await call(transport, at('load'), { id }, options);
      return row === null ? null : decodeWire.subscription(row);
    },
    activeFor: async (userId, sku, sellerId, options) => {
      const row = await call(
        transport,
        at('activeFor'),
        { userId, sku, sellerId },
        options,
      );
      return row === null ? null : decodeWire.subscription(row);
    },
    cancel: async (id, options) => {
      await call(transport, at('cancel'), { id }, options);
    },
    claimDue: async (now, limit, options) => {
      const rows = (await call(
        transport,
        at('claimDue'),
        { now, limit },
        options,
      )) as unknown[];
      return rows.map(decodeWire.subscription);
    },
    markBilled: (id, nextDueAt, expectedDueAt, options) =>
      call(
        transport,
        at('markBilled'),
        { id, nextDueAt, expectedDueAt },
        options,
      ) as Promise<boolean>,
    markLapsed: async (id, options) => {
      await call(transport, at('markLapsed'), { id }, options);
    },
  };
}

function sessionPromos(transport: Transport, session: string): PromoStore {
  const at = (method: string): string => `/tx/${session}/promos/${method}`;
  return {
    open: async (grant, options) => {
      await call(
        transport,
        at('open'),
        { grant: encodeWire.promoGrant(grant) },
        options,
      );
    },
    claimDue: async (now, limit, options) => {
      const rows = (await call(
        transport,
        at('claimDue'),
        { now, limit },
        options,
      )) as unknown[];
      return rows.map(decodeWire.promoGrant);
    },
    markReversed: async (id, options) => {
      await call(transport, at('markReversed'), { id }, options);
    },
  };
}

function rootTrust(transport: Transport): TrustStore {
  const at = (method: string): string => `/trust/${method}`;
  return {
    read: async (subject, options) =>
      decodeWire.velocity(
        await call(transport, at('read'), { subject }, options),
      ),
    bump: async (subject, attempt, options) => {
      await call(
        transport,
        at('bump'),
        { subject, attempt: encodeWire.attempt(attempt) },
        options,
      );
    },
    record: async (subject, attempt, options) =>
      decodeWire.velocity(
        await call(
          transport,
          at('record'),
          { subject, attempt: encodeWire.attempt(attempt) },
          options,
        ),
      ),
  };
}

function rootMovements(transport: Transport): MovementJournal {
  const at = (method: string): string => `/movements/${method}`;
  return {
    append: async (movements, options) => {
      await call(
        transport,
        at('append'),
        { movements: movements.map(encodeWire.movement) },
        options,
      );
    },
    bySession: async function* (sessionId, options) {
      const rows = (await call(
        transport,
        at('bySession'),
        { sessionId },
        options,
      )) as unknown[];
      for (const row of rows) {
        yield decodeWire.movement(row);
      }
    },
  };
}

function rootCheckpoints(transport: Transport): CheckpointStore {
  const at = (method: string): string => `/checkpoints/${method}`;
  return {
    put: async (checkpoint, options) => {
      await call(transport, at('put'), { checkpoint }, options);
    },
    latest: async (options) => {
      const row = await call(transport, at('latest'), {}, options);
      return row === null ? null : (row as Checkpoint);
    },
  };
}

function rootReplay(transport: Transport): ReplayStore {
  const at = (method: string): string => `/replay/${method}`;
  return {
    claim: (eventId, options) =>
      call(transport, at('claim'), { eventId }, options) as Promise<{
        claimed: boolean;
      }>,
  };
}

// --- The transaction --------------------------------------------------------------

async function runTransaction<T>(
  transport: Transport,
  work: (unit: Unit) => Promise<T>,
  options?: Options,
): Promise<T> {
  const { session } = (await call(transport, '/tx/begin', {}, options)) as {
    session: string;
  };
  const unit = sessionUnit(transport, session);
  try {
    const result = await work(unit);
    await call(transport, `/tx/${session}/commit`, {}, options);
    return result;
  } catch (error) {
    await call(transport, `/tx/${session}/rollback`, {}).catch(() => {});
    throw error;
  }
}

function sessionUnit(transport: Transport, session: string): Unit {
  return {
    ledger: sessionLedger(transport, session),
    idempotency: sessionIdempotency(transport, session),
    sales: sessionSales(transport, session),
    outbox: sessionOutbox(transport, session),
    inbox: sessionInbox(transport, session),
    sagas: sessionSagas(transport, session),
    entitlements: sessionEntitlements(transport, session),
    subscriptions: sessionSubscriptions(transport, session),
    promos: sessionPromos(transport, session),
    // The root endpoints, not session-scoped ones: a trust write commits on the server by
    // itself, so it survives a session rollback.
    trust: rootTrust(transport),
  };
}

// --- The assembled client Store ---------------------------------------------------

/**
 * Build a {@link Store} that does all its work over HTTP requests. Without a `fetch`, it
 * creates an in-process server ({@link createStoreServer}) over a fresh in-memory store
 * and points the client at it, so a bare `httpStore()` is a complete, working Store that
 * needs no running service or network.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for how this HTTP backend implements the storage port.
 */
export function httpStore(options?: HttpStoreOptions): Store {
  const backing = memoryStore();
  const fetch = options?.fetch ?? createStoreServer(backing);
  const baseUrl = options?.baseUrl ?? 'http://economy.local';
  const transport = { fetch, baseUrl };

  return {
    ...sessionUnit(transport, 'root'),
    checkpoints: rootCheckpoints(transport),
    movements: rootMovements(transport),
    replay: rootReplay(transport),
    transaction: (work, txOptions) =>
      runTransaction(transport, work, txOptions),
    close: async (closeOptions?: Options) => {
      await call(transport, '/close', {}, closeOptions);
    },
  };
}

// Re-exported so a host can attach the server side to a real HTTP listener.
export { createStoreServer } from '#src/adapters/http-server.ts';
