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

// A transaction that the server opened and is holding open between requests. The real
// database transaction is paused mid-flight, waiting on a promise (the "gate"), so later
// requests can keep using it before it finally commits or rolls back.
type Session = {
  // The transaction-scoped set of stores (ledger, sagas, etc.) this transaction writes to.
  // Every write through this unit commits or rolls back together.
  unit: Unit;

  // Call this to end the transaction: true tells the paused work to commit, false to roll
  // back. It does so by resolving or rejecting the gate promise the transaction is waiting on.
  settle: (commit: boolean) => void;

  // Resolves once the database transaction has finished committing or rolling back. Awaiting
  // it surfaces any error that only happens at commit time.
  done: Promise<void>;
};

// --- Session lifecycle ------------------------------------------------------------

// Open a database transaction and pause it so later requests can use it. We start the
// transaction, grab the per-transaction stores it hands us, then make the transaction body
// wait on a promise (the gate). The commit and rollback routes later resolve or reject that
// gate to finish it. Returns the new session id callers pass on every follow-up request.
function beginSession(backing: Store, sessions: Map<string, Session>): string {
  let id = `sess_${sessions.size}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let settle!: (commit: boolean) => void;
  let gate = new Promise<void>((resolve, reject) => {
    settle = (commit) =>
      commit ? resolve() : reject(new Error('transaction rolled back'));
  });
  // Record the session from inside the transaction body, saving the per-transaction stores
  // (the unit) we were handed. We fill in `done` with a placeholder here and overwrite it
  // just below, because the transaction promise we want to store doesn't exist yet at this
  // point. Nothing reads `done` before the real value is set.
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
  // A rollback rejects this promise, which would otherwise be reported as an unhandled
  // rejection. Catch and ignore it here: the rollback route succeeds either way, and a real
  // commit-time error is still seen because the commit route awaits `done` directly.
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

// Pick the ledger a request should run against. The literal id 'root' means a plain read
// outside any transaction, so use the backing store's own ledger; otherwise look up the held
// transaction by its session id and use that transaction's ledger.
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

// The remaining ledger reads, split into a second function only to keep each one short.
// These are a page of an account's entries (`statement`) plus three reads that stream their
// rows one at a time rather than returning a whole array: `heads` (every account paired with
// the latest hash in its tamper-evident chain), `timeline` (an account's settlement lots —
// chunks of funds with the date each becomes payable), and `lineage` (every posting that
// touched an account, with its hashes, used to verify the chain was not altered).
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
    return collect(ledger.timeline(body.account as AccountRef), (lot) => ({
      ...lot,
      amount: encodeWire.amount(lot.amount),
    }));
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

// Pick the per-transaction store set (the unit) a request should run against. The id 'root'
// means a call outside any transaction; the backing store exposes all the same sub-stores a
// unit does, so it can stand in directly. Any other id is a held transaction, so use the
// unit captured for that session.
function unitFor(
  backing: Store,
  sessions: Map<string, Session>,
  session: string,
): Unit {
  return session === 'root' ? backing : sessions.get(session)!.unit;
}

// Run one non-ledger sub-store call (sagas, idempotency, entitlements, and the rest). Looks up a
// handler in the route table by the "<store>/<method>" key from the request path and calls
// it; throws if the path names no such route.
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

// Every non-ledger sub-store call lives here, one entry per method. Each handler does the
// same three steps: turn the request body's wire form back into domain values, call the
// store method, and turn the result back into wire form. The client has a matching call for
// every entry in this table.
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
  'sagas/open': async (unit, body) => {
    await unit.sagas.open(decodeWire.saga(body.saga));
    return null;
  },
  'sagas/load': async (unit, body) => {
    let saga = await unit.sagas.load(body.id as string);
    return saga === null ? null : encodeWire.saga(saga);
  },
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

// Decode the fields being changed on a saga (a long-running multi-step payout the server
// tracks across states). The change set updates only some of a saga's fields, so its one
// money field, `reserve`, may be absent; decode that field from its wire string only when it
// is present, and otherwise pass the change set through unchanged.
function decodeSagaPatch(
  patch: unknown,
): Parameters<Unit['sagas']['advance']>[3] {
  let row = patch as Record<string, unknown>;
  return typeof row.reserve === 'string'
    ? ({ ...row, reserve: decodeWire.amount(row.reserve) } as Parameters<
        Unit['sagas']['advance']
      >[3])
    : (row as Parameters<Unit['sagas']['advance']>[3]);
}

// --- Routes that bypass transactions (trust, checkpoints) -------------------------
// The trust store (which keeps a running per-subject tally of recent spend used for risk
// checks) and the checkpoints are written directly on the backing store, not inside a held
// transaction, so these routes take the store rather than a session's unit.

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
  // `record` is the atomic record-and-measure the risk gate uses: run it on the backing store
  // (which is where the per-subject serialization actually happens) and send back the resulting
  // velocity wire-encoded, exactly as `read` encodes its result.
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

// The webhook replay store deduplicates incoming webhook events: claiming an event id
// succeeds the first time and fails on any repeat, so the same event is never processed
// twice. It is claimed directly on the backing store, never inside a held transaction (the
// webhook ingress checks it on its own before doing any work), so this route takes the store
// rather than a session's unit. Only `claim` exists; its `{ claimed }` result is a plain JSON
// object, so no codec is needed.
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
 * Build the server side of the HTTP store adapter: a function that takes a {@link Request}
 * and returns a {@link Response}, answering each request against the given backing
 * {@link Store}.
 *
 * A successful result is sent as `{ ok: true, body }`. If the handler throws, the response
 * is `{ ok: false, error }` with the error message — always HTTP 200, never an error status
 * code. The client reads that shape and re-throws the error, so a failed call rolls its
 * transaction back just as a normal in-process call would.
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
