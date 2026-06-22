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
 * The client half of the HTTP storage backend: it builds a Store (the data-access object
 * the rest of the system uses) whose every call becomes an HTTP request answered by a
 * server handler. This is the only file that uses the fetch API (Request, Response); the
 * rest of the system stays unaware that HTTP is involved.
 */

import { memoryStore } from '#src/adapters/memory.ts';
import { decodeWire, encodeWire } from '#src/adapters/http-wire.ts';
import { createStoreServer } from '#src/adapters/http-server.ts';

import type { AccountRef } from '#src/accounts.ts';
import type {
  Checkpoint,
  Lot,
  Options,
  OutboxMessage,
  StoredLink,
  Store,
  Unit,
  CheckpointStore,
  EntitlementStore,
  IdempotencyStore,
  Ledger,
  OutboxStore,
  PromoStore,
  ReplayStore,
  SagaStore,
  SaleStore,
  SubscriptionStore,
  TrustStore,
} from '#src/ports.ts';

/**
 * A function that takes an HTTP request and returns a response — the same shape as the
 * standard `fetch`. This is how the client talks to the server. When you don't supply
 * one, the default points at an in-process server, so no actual network call happens.
 */
export type FetchLike = (request: Request) => Promise<Response>;

/** Options for {@link httpStore}. */
export type HttpStoreOptions = {
  // The function used to send requests. Defaults to an in-process server running over a
  // fresh in-memory store, so requests stay inside this process.
  fetch?: FetchLike;

  // The origin (scheme + host) that request URLs are built against. Only matters when
  // requests go over a real network; ignored for the in-process default.
  baseUrl?: string;
};

// The shape of every response body. Either a successful result, or a failure carrying the
// server's error message. On failure the client re-throws that message as an Error, so a
// handler that fails on the server fails the same way it would have in-process — which
// lets the transaction roll back.
type WireResult = { ok: true; body: unknown } | { ok: false; error: string };

// --- The transport call -----------------------------------------------------------

// Make one request and get one result back. POST the JSON arguments to `path`, read the
// response, and if the server reported a failure, throw it as an Error here so the caller
// sees the same failure it would from an in-process store (which is what makes a failed
// transaction roll back).
async function call(
  transport: { fetch: FetchLike; baseUrl: string },
  path: string,
  payload: unknown,
  options?: Options,
): Promise<unknown> {
  let request = new Request(new URL(path, transport.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options?.signal,
  });
  let response = await transport.fetch(request);
  let result = (await response.json()) as WireResult;
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.body;
}

// --- The ledger, scoped to one transaction ----------------------------------------

// Build the ledger interface for one open transaction. A transaction lives on the server
// as a "session" identified by `session`; every method here puts that id in the request
// path, so all of these calls run inside the one transaction the server is holding open.
// The special id 'root' means "not in a transaction": each such call runs on its own.
function sessionLedger(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): Ledger {
  let at = (method: string): string => `/tx/${session}/ledger/${method}`;
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
      let row = await call(transport, at('posting'), { txnId }, options);
      return row === null ? null : decodeWire.posting(row);
    },
    statement: async (account, range, options) =>
      decodeWire.statement(
        await call(transport, at('statement'), { account, range }, options),
      ),
    timeline: (account) => streamLots(transport, account, session),
    heads: () => streamHeads(transport, session),
    balanceAccounts: (options) =>
      streamBalanceAccounts(transport, session, options),
    lineage: (account, options) =>
      streamLineage(transport, account, session, options),
  };
}

// --- Streamed reads ---------------------------------------------------------------

// heads, timeline, and lineage are declared as async iterables (you loop over them with
// `for await`) so a real backend could stream large result sets a page at a time. This
// in-process version doesn't paginate: the server returns everything in one response, and
// these generators just hand back the rows one by one.
// Streams each account paired with the hash of its most recent entry — every account has a
// hash-chain of entries, and that latest hash is its "head".
async function* streamHeads(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): AsyncIterable<readonly [AccountRef, string]> {
  let rows = (await call(
    transport,
    `/tx/${session}/ledger/heads`,
    {},
  )) as Array<[string, string]>;
  for (let [account, head] of rows) {
    yield [account as AccountRef, head] as const;
  }
}

// Every account that has a cached running balance, streamed one at a time. (The store keeps a
// per-account balance as a cache; the individual entries are the source of truth, and this
// cached figure can fall out of sync.) Like `heads`, the in-process server returns all rows in
// one response and this generator hands them back one by one; the account ids are plain strings
// re-branded as AccountRef on arrival (no money amount crosses the wire here, so no amount codec
// is needed).
async function* streamBalanceAccounts(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
  options?: Options,
): AsyncIterable<AccountRef> {
  let rows = (await call(
    transport,
    `/tx/${session}/ledger/balanceAccounts`,
    {},
    options,
  )) as string[];
  for (let account of rows) {
    yield account as AccountRef;
  }
}

async function* streamLots(
  transport: { fetch: FetchLike; baseUrl: string },
  account: AccountRef,
  session: string,
): AsyncIterable<Lot> {
  let rows = (await call(transport, `/tx/${session}/ledger/timeline`, {
    account,
  })) as unknown[];
  for (let row of rows) {
    yield decodeWire.lot(row);
  }
}

async function* streamLineage(
  transport: { fetch: FetchLike; baseUrl: string },
  account: AccountRef,
  session: string,
  options?: Options,
): AsyncIterable<StoredLink> {
  let rows = (await call(
    transport,
    `/tx/${session}/ledger/lineage`,
    { account },
    options,
  )) as unknown[];
  for (let row of rows) {
    yield decodeWire.storedLink(row);
  }
}

// --- The sub-stores, scoped to one transaction ------------------------------------
// Each builder below returns one sub-store's interface for a given session id, turning
// every method into a request to that session (or to 'root' for calls outside a
// transaction). Arguments and results that contain money amounts are run through the wire
// codec, which carries each amount as a decimal string (plain JSON can't serialize the
// bigint the amounts are made of).

function sessionIdempotency(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): IdempotencyStore {
  let at = (method: string): string => `/tx/${session}/idempotency/${method}`;
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

function sessionSales(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): SaleStore {
  let at = (method: string): string => `/tx/${session}/sales/${method}`;
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
      let row = await call(transport, at('get'), { orderId }, options);
      return row === null ? null : decodeWire.sale(row);
    },
  };
}

function sessionOutbox(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): OutboxStore {
  let at = (method: string): string => `/tx/${session}/outbox/${method}`;
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
  };
}

function sessionSagas(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): SagaStore {
  let at = (method: string): string => `/tx/${session}/sagas/${method}`;
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
      let row = await call(transport, at('load'), { id }, options);
      return row === null ? null : decodeWire.saga(row);
    },
    claimDue: async (now, limit, options) => {
      let rows = (await call(
        transport,
        at('claimDue'),
        { now, limit },
        options,
      )) as unknown[];
      return rows.map(decodeWire.saga);
    },
    // SagaStore.advance is declared as advance(id, from, to, patch, options?). This arrow
    // accepts only the first four arguments and leaves out the optional `options` (which
    // would carry a cancellation signal). That's fine: a function taking fewer arguments is
    // still a valid implementation, and the only caller — the background sweep that retries
    // sagas — never passes a signal, so nothing relies on it here.
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
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): EntitlementStore {
  let at = (method: string): string => `/tx/${session}/entitlements/${method}`;
  return {
    grant: async (userId, sku, attrs, options) => {
      await call(transport, at('grant'), { userId, sku, attrs }, options);
    },
    revoke: async (userId, sku, options) => {
      await call(transport, at('revoke'), { userId, sku }, options);
    },
    owns: (userId, sku, options) =>
      call(transport, at('owns'), { userId, sku }, options) as Promise<boolean>,
  };
}

function sessionSubscriptions(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): SubscriptionStore {
  let at = (method: string): string => `/tx/${session}/subscriptions/${method}`;
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
      let row = await call(transport, at('load'), { id }, options);
      return row === null ? null : decodeWire.subscription(row);
    },
    activeFor: async (userId, sku, sellerId, options) => {
      let row = await call(
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
      let rows = (await call(
        transport,
        at('claimDue'),
        { now, limit },
        options,
      )) as unknown[];
      return rows.map(decodeWire.subscription);
    },
    // markBilled is a compare-and-set: the server returns whether the row still matched
    // `expectedDueAt`, and that boolean must survive the round trip so an overlapping sweeper
    // that lost the race sees `false` and treats its renewal as a no-op.
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

function sessionPromos(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): PromoStore {
  let at = (method: string): string => `/tx/${session}/promos/${method}`;
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
      let rows = (await call(
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

// The trust store: it tracks how much each subject has spent recently, which is the input the
// risk check reads. It is never part of a transaction; its writes happen on their own, so even a
// denied attempt still counts toward the spending limit. Because of that it has its own
// endpoints with no session id.
function rootTrust(transport: {
  fetch: FetchLike;
  baseUrl: string;
}): TrustStore {
  let at = (method: string): string => `/trust/${method}`;
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
    // Proxy the atomic record-and-measure: send the same {subject, attempt} payload `bump` does,
    // and decode the Velocity the server returns (the server runs the real backing store's
    // `record`, so the atomicity lives there, not on the wire). Same amount codecs as read+bump.
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

// The checkpoint store (signed snapshots of the ledger). Only the background worker uses
// it, and like trust it is never part of a transaction, so it too has session-less endpoints.
function rootCheckpoints(transport: {
  fetch: FetchLike;
  baseUrl: string;
}): CheckpointStore {
  let at = (method: string): string => `/checkpoints/${method}`;
  return {
    put: async (checkpoint, options) => {
      await call(transport, at('put'), { checkpoint }, options);
    },
    latest: async (options) => {
      let row = await call(transport, at('latest'), {}, options);
      return row === null ? null : (row as Checkpoint);
    },
  };
}

// The webhook replay store: it records each inbound provider event by the event id the provider
// gave it, so the same webhook delivered twice is only processed once. Like trust and
// checkpoints it is never part of a domain transaction — the webhook entry point claims the
// event id on its own, as a final duplicate check before processing — so it has its own
// session-less endpoint.
function rootReplay(transport: {
  fetch: FetchLike;
  baseUrl: string;
}): ReplayStore {
  let at = (method: string): string => `/replay/${method}`;
  return {
    claim: (eventId, options) =>
      call(transport, at('claim'), { eventId }, options) as Promise<{
        claimed: boolean;
      }>,
  };
}

// --- The transaction --------------------------------------------------------------

// Run `work` inside a transaction. Ask the server to begin one (it replies with a session
// id), run the caller's `work` against a Unit bound to that session, then tell the server to
// commit if `work` succeeded or roll back if it threw. The actual begin/commit/rollback
// happens in the server's backing store, so this client adds no transaction logic of its own.
async function runTransaction<T>(
  transport: { fetch: FetchLike; baseUrl: string },
  work: (tx: Unit) => Promise<T>,
  options?: Options,
): Promise<T> {
  let { session } = (await call(transport, '/tx/begin', {}, options)) as {
    session: string;
  };
  let unit = sessionUnit(transport, session);
  try {
    let result = await work(unit);
    await call(transport, `/tx/${session}/commit`, {}, options);
    return result;
  } catch (error) {
    await call(transport, `/tx/${session}/rollback`, {}).catch(() => {});
    throw error;
  }
}

// Bundle the sub-stores a handler is allowed to use inside a transaction, all bound to the
// same session. Trust and checkpoints are deliberately left out, because they are never part
// of a transaction.
function sessionUnit(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): Unit {
  return {
    ledger: sessionLedger(transport, session),
    idempotency: sessionIdempotency(transport, session),
    sales: sessionSales(transport, session),
    outbox: sessionOutbox(transport, session),
    sagas: sessionSagas(transport, session),
    entitlements: sessionEntitlements(transport, session),
    subscriptions: sessionSubscriptions(transport, session),
    promos: sessionPromos(transport, session),
  };
}

// --- The assembled client Store ---------------------------------------------------

/**
 * Build a {@link Store} that does all its work over HTTP requests. If you don't pass your
 * own `fetch`, it creates an in-process server ({@link createStoreServer}) backed by a fresh
 * in-memory store and points the client at it — so a bare `httpStore()` is a complete,
 * working Store that needs no running service or network.
 */
export function httpStore(options?: HttpStoreOptions): Store {
  let backing = memoryStore();
  let fetch = options?.fetch ?? createStoreServer(backing);
  let baseUrl = options?.baseUrl ?? 'http://economy.local';
  let transport = { fetch, baseUrl };

  return {
    ledger: sessionLedger(transport, 'root'),
    idempotency: sessionIdempotency(transport, 'root'),
    sales: sessionSales(transport, 'root'),
    outbox: sessionOutbox(transport, 'root'),
    sagas: sessionSagas(transport, 'root'),
    entitlements: sessionEntitlements(transport, 'root'),
    subscriptions: sessionSubscriptions(transport, 'root'),
    promos: sessionPromos(transport, 'root'),
    trust: rootTrust(transport),
    checkpoints: rootCheckpoints(transport),
    replay: rootReplay(transport),
    transaction: (work, txOptions) =>
      runTransaction(transport, work, txOptions),
    close: async (closeOptions?: Options) => {
      await call(transport, '/close', {}, closeOptions);
    },
  };
}

// Re-exported so a host can attach the server side to a real HTTP listener. The in-process
// server is only the default; exporting it here means both the client and server halves are
// available from this one module.
export { createStoreServer } from '#src/adapters/http-server.ts';
