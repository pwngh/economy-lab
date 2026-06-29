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

import { decodeWire, encodeWire } from '#src/adapters/http-wire.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Store, Unit } from '#src/ports.ts';

// A transaction held open between requests. The db transaction is paused mid-flight, waiting
// on a promise (the "gate"), so later requests reuse it before it commits or rolls back.
type Session = {
  // Transaction-scoped stores (ledger, sagas, etc.); all writes commit or roll back together.
  unit: Unit;

  // End the transaction: true commits, false rolls back, by resolving/rejecting the gate.
  settle: (commit: boolean) => void;

  // Resolves once the db transaction has committed or rolled back. Awaiting surfaces any
  // commit-time error.
  done: Promise<void>;
};

// --- Session lifecycle ------------------------------------------------------------

// Open a db transaction and pause its body on the gate promise so later requests can use it.
// The commit/rollback routes resolve or reject the gate to finish it. Returns the session id
// callers pass on every follow-up request.
function beginSession(backing: Store, sessions: Map<string, Session>): string {
  let id = `sess_${sessions.size}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let settle!: (commit: boolean) => void;
  let gate = new Promise<void>((resolve, reject) => {
    settle = (commit) =>
      commit ? resolve() : reject(new Error('transaction rolled back'));
  });
  // Record the session from inside the transaction body, saving its unit. `done` is a
  // placeholder here, overwritten just below, since the transaction promise doesn't exist yet.
  // Nothing reads `done` before the real value is set.
  let done = backing
    .transaction(async (unit) => {
      sessions.set(id, {
        unit,
        settle,
        done: undefined as unknown as Promise<void>,
      });
      await gate;
    })
    .then(() => undefined);
  sessions.get(id)!.done = done;
  // A rollback rejects this promise; catch it here to avoid an unhandled rejection. The
  // rollback route succeeds either way, and commit-time errors still surface because the
  // commit route awaits `done` directly.
  done.catch(() => {});
  return id;
}

async function commitSession(session: Session): Promise<void> {
  session.settle(true);
  await session.done;
}

async function rollbackSession(session: Session): Promise<void> {
  session.settle(false);
  await session.done.catch(() => {});
}

// --- Ledger routes ----------------------------------------------------------------

// Pick the ledger for a request. Session id 'root' means a read outside any transaction, so
// use the backing store's ledger; otherwise use the held transaction's ledger.
function ledgerFor(
  backing: Store,
  sessions: Map<string, Session>,
  session: string,
) {
  return session === 'root'
    ? backing.ledger
    : sessions.get(session)!.unit.ledger;
}

async function ledgerRoute(
  ledger: Store['ledger'],
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'hasAccount') {
    return ledger.hasAccount(body.account as AccountRef);
  }
  if (method === 'lock') {
    await ledger.lock(body.account as AccountRef);
    return null;
  }
  if (method === 'append') {
    return encodeWire.transaction(
      await ledger.append(decodeWire.posting(body)),
    );
  }
  if (method === 'balance') {
    return encodeWire.amount(await ledger.balance(body.account as AccountRef));
  }
  if (method === 'posting') {
    let posting = await ledger.posting(body.txnId as string);
    return posting === null ? null : encodeWire.posting(posting);
  }
  return ledgerReadRoute(ledger, method, body);
}

// Remaining ledger reads, split out to keep each function short. `statement` returns one page;
// `heads`, `timeline`, `lineage`, and `list` stream rows one at a time, so each collects into an
// array here.
async function ledgerReadRoute(
  ledger: Store['ledger'],
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'statement') {
    let range = body.range as { from: number; to: number };
    let statement = await ledger.statement(body.account as AccountRef, range);
    return { ...statement, entries: statement.entries.map(encodeEntry) };
  }
  if (method === 'heads') {
    return collect(ledger.heads(), (head) => head as unknown);
  }
  if (method === 'balanceAccounts') {
    return collect(ledger.balanceAccounts(), (account) => account as unknown);
  }
  if (method === 'timeline') {
    // Pass the bounded read straight through to the backing ledger, so a `desc`/`limit` request
    // bounds the real engine's DB work rather than being applied after a full fetch.
    let timelineOptions = {
      order: body.order as 'asc' | 'desc' | undefined,
      limit: body.limit as number | undefined,
      offset: body.offset as number | undefined,
    };
    return collect(
      ledger.timeline(body.account as AccountRef, timelineOptions),
      (lot) => ({ ...lot, amount: encodeWire.amount(lot.amount) }),
    );
  }
  if (method === 'list') {
    return collect(ledger.list(), (posting) => encodeWire.posting(posting));
  }
  return collect(ledger.lineage(body.account as AccountRef), (link) => ({
    ...link,
    legs: link.legs.map((leg) => ({
      account: leg.account,
      amount: encodeWire.amount(leg.amount),
    })),
  }));
}

function encodeEntry(entry: {
  txnId: string;
  amount: Parameters<typeof encodeWire.amount>[0];
  postedAt: number;
}): unknown {
  return {
    txnId: entry.txnId,
    amount: encodeWire.amount(entry.amount),
    postedAt: entry.postedAt,
  };
}

async function collect<T>(
  source: AsyncIterable<T>,
  map: (item: T) => unknown,
): Promise<unknown[]> {
  let rows: unknown[] = [];
  for await (let item of source) {
    rows.push(map(item));
  }
  return rows;
}

// --- Sub-store routes -------------------------------------------------------------

// Pick the unit for a request. Session id 'root' means a call outside any transaction; the
// backing store exposes the same sub-stores a unit does, so it stands in directly. Otherwise
// use the unit captured for that session.
function unitFor(
  backing: Store,
  sessions: Map<string, Session>,
  session: string,
): Unit {
  return session === 'root' ? backing : sessions.get(session)!.unit;
}

// Run one non-ledger sub-store call (sagas, idempotency, entitlements, etc.). Looks up the
// handler by "<store>/<method>" key from the path; throws if no such route.
async function subStoreRoute(
  unit: Unit,
  store: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  let handler = SUBSTORE_ROUTES[`${store}/${method}`];
  if (!handler) {
    throw new Error(`unknown route ${store}/${method}`);
  }
  return handler(unit, body);
}

type SubHandler = (
  unit: Unit,
  body: Record<string, unknown>,
) => Promise<unknown>;

// Every non-ledger sub-store call, one entry per method. Each handler decodes the body's wire
// form to domain values, calls the store method, and encodes the result back. The client has
// a matching call for every entry.
let SUBSTORE_ROUTES: Record<string, SubHandler> = {
  'idempotency/claim': async (unit, body) => {
    let result = await unit.idempotency.claim(body.key as string);
    return result.claimed
      ? { claimed: true }
      : {
          claimed: false,
          transaction: encodeWire.transaction(result.transaction),
        };
  },
  'idempotency/record': async (unit, body) => {
    await unit.idempotency.record(
      body.key as string,
      decodeWire.transaction(body.transaction),
    );
    return null;
  },
  'sales/put': async (unit, body) => {
    await unit.sales.put(decodeWire.sale(body.sale));
    return null;
  },
  'sales/get': async (unit, body) => {
    let sale = await unit.sales.get(body.orderId as string);
    return sale === null ? null : encodeWire.sale(sale);
  },
  'outbox/enqueue': async (unit, body) => {
    await unit.outbox.enqueue(
      body.message as Parameters<typeof unit.outbox.enqueue>[0],
    );
    return null;
  },
  'outbox/claimBatch': (unit, body) =>
    unit.outbox.claimBatch(body.limit as number),
  'outbox/markRelayed': async (unit, body) => {
    await unit.outbox.markRelayed(body.ids as ReadonlyArray<string>);
    return null;
  },
  'outbox/recordFailure': async (unit, body) => {
    await unit.outbox.recordFailure(body.id as string);
    return null;
  },
  'outbox/deadLetter': async (unit, body) => {
    await unit.outbox.deadLetter(body.id as string, body.reason as string);
    return null;
  },
  'inbox/enqueueInbound': async (unit, body) => {
    let stored = await unit.inbox.enqueueInbound(
      decodeWire.inboxEntry(body.entry),
    );
    return encodeWire.inboxEntry(stored);
  },
  'inbox/claimInbound': async (unit, body) => {
    let pending = await unit.inbox.claimInbound(
      body as Parameters<typeof unit.inbox.claimInbound>[0],
    );
    return pending.map(encodeWire.inboxEntry);
  },
  'inbox/markApplied': async (unit, body) => {
    await unit.inbox.markApplied(body.id as string);
    return null;
  },
  'inbox/bumpAttempt': async (unit, body) => {
    await unit.inbox.bumpAttempt(body.id as string);
    return null;
  },
  'inbox/deadLetter': async (unit, body) => {
    await unit.inbox.deadLetter(body.id as string, body.reason as string);
    return null;
  },
  'sagas/open': async (unit, body) => {
    await unit.sagas.open(decodeWire.saga(body.saga));
    return null;
  },
  'sagas/load': async (unit, body) => {
    let saga = await unit.sagas.load(body.id as string);
    return saga === null ? null : encodeWire.saga(saga);
  },
  'sagas/list': (unit) => collect(unit.sagas.list(), encodeWire.saga),
  'sagas/claimDue': async (unit, body) => {
    let due = await unit.sagas.claimDue(
      body.now as number,
      body.limit as number,
    );
    return due.map(encodeWire.saga);
  },
  'sagas/advance': (unit, body) =>
    unit.sagas.advance(
      body.id as string,
      body.from as Parameters<typeof unit.sagas.advance>[1],
      body.to as Parameters<typeof unit.sagas.advance>[2],
      decodeSagaPatch(body.patch),
    ),
  'sagas/deadLetter': async (unit, body) => {
    await unit.sagas.deadLetter(body.id as string, body.reason as string);
    return null;
  },
  'sagas/lastPayoutAt': (unit, body) =>
    unit.sagas.lastPayoutAt(body.userId as string),
  'entitlements/grant': async (unit, body) => {
    await unit.entitlements.grant(
      body.userId as string,
      body.sku as string,
      body.attrs as Parameters<typeof unit.entitlements.grant>[2],
    );
    return null;
  },
  'entitlements/revoke': async (unit, body) => {
    await unit.entitlements.revoke(body.userId as string, body.sku as string);
    return null;
  },
  'entitlements/owns': (unit, body) =>
    unit.entitlements.owns(body.userId as string, body.sku as string),
  'subscriptions/open': async (unit, body) => {
    await unit.subscriptions.open(decodeWire.subscription(body.sub));
    return null;
  },
  'subscriptions/load': async (unit, body) => {
    let sub = await unit.subscriptions.load(body.id as string);
    return sub === null ? null : encodeWire.subscription(sub);
  },
  'subscriptions/activeFor': async (unit, body) => {
    let sub = await unit.subscriptions.activeFor(
      body.userId as string,
      body.sku as string,
      body.sellerId as string,
    );
    return sub === null ? null : encodeWire.subscription(sub);
  },
  'subscriptions/cancel': async (unit, body) => {
    await unit.subscriptions.cancel(body.id as string);
    return null;
  },
  'subscriptions/claimDue': async (unit, body) => {
    let due = await unit.subscriptions.claimDue(
      body.now as number,
      body.limit as number,
    );
    return due.map(encodeWire.subscription);
  },
  'subscriptions/markBilled': (unit, body) =>
    unit.subscriptions.markBilled(
      body.id as string,
      body.nextDueAt as number,
      body.expectedDueAt as number,
    ),
  'subscriptions/markLapsed': async (unit, body) => {
    await unit.subscriptions.markLapsed(body.id as string);
    return null;
  },
  'promos/open': async (unit, body) => {
    await unit.promos.open(decodeWire.promoGrant(body.grant));
    return null;
  },
  'promos/claimDue': async (unit, body) => {
    let due = await unit.promos.claimDue(
      body.now as number,
      body.limit as number,
    );
    return due.map(encodeWire.promoGrant);
  },
  'promos/markReversed': async (unit, body) => {
    await unit.promos.markReversed(body.id as string);
    return null;
  },
};

// Decode a saga patch (a saga is a long-running multi-step payout tracked across states). The
// patch updates only some fields, so its one money field `reserve` may be absent; decode it
// from the wire string only when present, otherwise pass the patch through unchanged.
function decodeSagaPatch(
  patch: unknown,
): Parameters<Unit['sagas']['advance']>[3] {
  let row = { ...(patch as Record<string, unknown>) };
  // Decode the amount-typed fields that ride the wire as encoded strings (reserve, payoutUsd) back
  // to Amounts; everything else passes through. payoutUsd is null before settlement, so only decode
  // an actual encoded-amount string.
  if (typeof row.reserve === 'string') {
    row.reserve = decodeWire.amount(row.reserve);
  }
  if (typeof row.payoutUsd === 'string') {
    row.payoutUsd = decodeWire.amount(row.payoutUsd);
  }
  return row as Parameters<Unit['sagas']['advance']>[3];
}

// --- Routes that bypass transactions (trust, checkpoints) -------------------------
// The trust store (a running per-subject tally of recent spend, used for risk checks) and the
// checkpoints write directly on the backing store, not inside a held transaction, so these
// routes take the store rather than a session's unit.

async function trustRoute(
  backing: Store,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'read') {
    let velocity = await backing.trust.read(body.subject as string);
    return { ...velocity, spent: encodeWire.amount(velocity.spent) };
  }
  let wireAttempt = body.attempt as Record<string, unknown>;
  let attempt = {
    ...wireAttempt,
    amount: decodeWire.amount(wireAttempt.amount),
  } as Parameters<typeof backing.trust.bump>[1];
  // `record` is the atomic record-and-measure the risk gate uses. Run it on the backing store
  // (where per-subject serialization happens) and return the velocity wire-encoded, same as `read`.
  if (method === 'record') {
    let velocity = await backing.trust.record(body.subject as string, attempt);
    return { ...velocity, spent: encodeWire.amount(velocity.spent) };
  }
  await backing.trust.bump(body.subject as string, attempt);
  return null;
}

async function checkpointRoute(
  backing: Store,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'put') {
    await backing.checkpoints.put(
      body.checkpoint as Parameters<typeof backing.checkpoints.put>[0],
    );
    return null;
  }
  return backing.checkpoints.latest();
}

// The webhook replay store dedups incoming events: claiming an event id succeeds the first
// time and fails on repeats. Claimed directly on the backing store, never inside a held
// transaction (webhook ingress checks it before doing work), so this route takes the store.
// Only `claim` exists; its `{ claimed }` result is plain JSON, no codec needed.
async function replayRoute(
  backing: Store,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'claim') {
    return backing.replay.claim(body.eventId as string);
  }
  throw new Error(`unknown route replay/${method}`);
}

// --- The request router -----------------------------------------------------------

// Route one request to its handler based on the first path segment. The recognized paths are:
//   /tx/begin                       open a new held transaction
//   /tx/<id>/commit | rollback      finish a held transaction
//   /tx/<id>/<store>/<method>       a call inside a held transaction
//   /trust/<method>                 a trust-accumulator call
//   /checkpoints/<method>           a checkpoint call
//   /replay/<method>                a webhook replay-dedup call
//   /close                          shut the backing store down
async function dispatch(
  backing: Store,
  sessions: Map<string, Session>,
  segments: string[],
  body: Record<string, unknown>,
): Promise<unknown> {
  if (segments[0] === 'tx') {
    return txDispatch(backing, sessions, segments, body);
  }
  if (segments[0] === 'trust') {
    return trustRoute(backing, segments[1]!, body);
  }
  if (segments[0] === 'checkpoints') {
    return checkpointRoute(backing, segments[1]!, body);
  }
  if (segments[0] === 'replay') {
    return replayRoute(backing, segments[1]!, body);
  }
  if (segments[0] === 'close') {
    await backing.close();
    return null;
  }
  throw new Error(`unknown path /${segments.join('/')}`);
}

async function txDispatch(
  backing: Store,
  sessions: Map<string, Session>,
  segments: string[],
  body: Record<string, unknown>,
): Promise<unknown> {
  if (segments[1] === 'begin') {
    return { session: beginSession(backing, sessions) };
  }
  let session = segments[1]!;
  let tail = segments.slice(2);
  if (tail[0] === 'commit') {
    await commitSession(sessions.get(session)!);
    sessions.delete(session);
    return null;
  }
  if (tail[0] === 'rollback') {
    await rollbackSession(sessions.get(session)!);
    sessions.delete(session);
    return null;
  }
  if (tail[0] === 'ledger') {
    return ledgerRoute(ledgerFor(backing, sessions, session), tail[1]!, body);
  }
  return subStoreRoute(
    unitFor(backing, sessions, session),
    tail[0]!,
    tail[1]!,
    body,
  );
}

// --- The Fetch handler ------------------------------------------------------------

/**
 * Server side of the HTTP store adapter: a {@link Request} → {@link Response} function
 * answering each request against the backing {@link Store}.
 *
 * Success sends `{ ok: true, body }`; a thrown handler sends `{ ok: false, error }` with the
 * message, always HTTP 200. The client re-throws on that shape, so a failed call rolls its
 * transaction back like an in-process call would.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for the request protocol and route map.
 */
export function createStoreServer(
  backing: Store,
): (request: Request) => Promise<Response> {
  let sessions = new Map<string, Session>();
  return async (request) => {
    let segments = new URL(request.url).pathname.split('/').filter(Boolean);
    let body = (await readBody(request)) as Record<string, unknown>;
    try {
      let result = await dispatch(backing, sessions, segments, body);
      return jsonResponse({ ok: true, body: result ?? null });
    } catch (error) {
      return jsonResponse({ ok: false, error: messageOf(error) });
    }
  };
}

async function readBody(request: Request): Promise<unknown> {
  let text = await request.text();
  return text.length === 0 ? {} : JSON.parse(text);
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
