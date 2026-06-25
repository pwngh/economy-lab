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
 * Client half of the HTTP storage backend: builds a Store whose every call becomes an
 * HTTP request answered by a server handler. Only file that uses the fetch API (Request,
 * Response); the rest of the system stays unaware HTTP is involved.
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
  TrustStore,
} from '#src/ports.ts';

/**
 * Same shape as standard `fetch`: takes a Request, returns a Response. How the client
 * talks to the server. The default points at an in-process server, so no network call.
 */
export type FetchLike = (request: Request) => Promise<Response>;

/** Options for {@link httpStore}. */
export type HttpStoreOptions = {
  // Sends requests. Defaults to an in-process server over a fresh in-memory store, so
  // requests stay inside this process.
  fetch?: FetchLike;

  // Origin (scheme + host) request URLs are built against. Only matters over a real
  // network; ignored for the in-process default.
  baseUrl?: string;
};

// Every response body: a successful result, or a failure carrying the server's error
// message. On failure the client re-throws it as an Error, so a server-side handler
// failure looks the same as in-process, which lets the transaction roll back.
type WireResult = { ok: true; body: unknown } | { ok: false; error: string };

// --- The transport call -----------------------------------------------------------

// One request, one result. POST the JSON args to `path`, read the response, and re-throw
// any server failure as an Error so the caller sees the same failure it would in-process
// (which makes a failed transaction roll back).
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

// Ledger interface for one open transaction. A transaction lives on the server as a
// "session" identified by `session`; every method puts that id in the request path, so
// the calls run inside the transaction the server holds open. Id 'root' means "not in a
// transaction": each such call runs on its own.
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
    list: (options) => streamPostings(transport, session, options),
  };
}

// --- Streamed reads ---------------------------------------------------------------

// These are async iterables so a real backend could paginate; this in-process version returns
// everything in one response and yields rows one by one.

// Streams each account paired with the hash of its most recent entry. Each account has a
// hash-chain of entries; that latest hash is its "head".
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

// Every account with a cached running balance, one at a time. (The per-account balance is
// a cache; the entries are the source of truth, and the cached figure can fall out of
// sync.) Like `heads`, all rows come in one response and are yielded one by one; account
// ids are plain strings re-branded as AccountRef on arrival (no amount crosses the wire,
// so no amount codec needed).
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

// Every committed posting, newest first, one at a time. Like the other streamed reads, the server
// returns them in one response and this yields them in order; each row carries its legs' amounts,
// so it runs back through the wire codec (decodeWire.posting), unlike the amount-free `heads` and
// `balanceAccounts` streams.
async function* streamPostings(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
  options?: Options,
): AsyncIterable<Posting> {
  let rows = (await call(
    transport,
    `/tx/${session}/ledger/list`,
    {},
    options,
  )) as unknown[];
  for (let row of rows) {
    yield decodeWire.posting(row);
  }
}

// --- The sub-stores, scoped to one transaction ------------------------------------
// Each builder returns one sub-store's interface for a session id, turning every method
// into a request to that session (or 'root' for calls outside a transaction). Args and
// results containing money amounts run through the wire codec, which carries each amount
// as a decimal string (plain JSON can't serialize the underlying bigint).

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

function sessionInbox(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): InboxStore {
  let at = (method: string): string => `/tx/${session}/inbox/${method}`;
  return {
    // Dedupes on `key`: the server returns the existing row for a duplicate provider event, so the
    // resolved entry must survive the round trip. Unlike the outbox message, an InboxEntry carries a
    // whole Operation whose money fields hold a bigint JSON can't serialize, so it rides through the
    // `inboxEntry` codec (amounts as decimal strings) both ways.
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
    // Whole payout board (see SagaStore.list). Like the ledger stream reads, the in-process server
    // returns every row in one response; yield them one at a time to honor the AsyncIterable.
    list: async function* (options) {
      let rows = (await call(transport, at('list'), {}, options)) as unknown[];
      for (let row of rows) {
        yield decodeWire.saga(row);
      }
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
    // SagaStore.advance is advance(id, from, to, patch, options?). This arrow takes only
    // the first four and omits the optional `options` (a cancellation signal). Fine: fewer
    // args is still a valid implementation, and the only caller (the background saga-retry
    // sweep) never passes a signal.
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
    // `expectedDueAt`. That boolean must survive the round trip so an overlapping sweeper
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

// Trust store: tracks how much each subject has spent recently, the input the risk check
// reads. Never part of a transaction; its writes happen on their own, so even a denied
// attempt counts toward the spending limit. Hence its own endpoints with no session id.
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
    // Proxy the atomic record-and-measure: send the same {subject, attempt} payload as
    // `bump`, decode the Velocity the server returns. The server runs the backing store's
    // `record`, so atomicity lives there, not on the wire. Same amount codecs as read+bump.
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

// Checkpoint store (signed snapshots of the ledger). Only the background worker uses it,
// and like trust it is never part of a transaction, so it too has session-less endpoints.
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

// Webhook replay store: records each inbound provider event by the provider's event id, so
// the same webhook delivered twice is processed once. Never part of a domain transaction;
// the webhook entry point claims the event id on its own as a final duplicate check before
// processing. Hence its own session-less endpoint.
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

// Run `work` inside a transaction. Ask the server to begin one (replies with a session
// id), run `work` against a Unit bound to that session, then commit if it succeeded or
// roll back if it threw. The actual begin/commit/rollback happens in the server's backing
// store, so this client adds no transaction logic of its own.
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

// Bundle the sub-stores a handler may use inside a transaction, all bound to the same
// session. Trust and checkpoints are left out: they are never part of a transaction.
function sessionUnit(
  transport: { fetch: FetchLike; baseUrl: string },
  session: string,
): Unit {
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
  };
}

// --- The assembled client Store ---------------------------------------------------

/**
 * Build a {@link Store} that does all its work over HTTP requests. Without a `fetch`, it
 * creates an in-process server ({@link createStoreServer}) over a fresh in-memory store
 * and points the client at it, so a bare `httpStore()` is a complete, working Store that
 * needs no running service or network.
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
    inbox: sessionInbox(transport, 'root'),
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
// server is only the default; exporting it here makes both halves available from this module.
export { createStoreServer } from '#src/adapters/http-server.ts';
