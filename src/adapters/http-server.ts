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

// Holds a db transaction open across several requests. The transaction body pauses on a promise
// called the gate, so later requests run inside it before it commits or rolls back.
type Session = {
  // The transaction-scoped stores, such as the ledger and sagas. All their writes commit or roll
  // back together.
  unit: Unit;

  // Ends the transaction by resolving or rejecting the gate. True commits and false rolls back.
  settle: (commit: boolean) => void;

  // Resolves once the db transaction has committed or rolled back. Awaiting surfaces any
  // commit-time error.
  done: Promise<void>;
};

// --- Session lifecycle ------------------------------------------------------------

// Opens a db transaction and pauses its body on the gate promise so later requests can use it.
// The commit and rollback routes resolve or reject the gate to finish it. Returns the session id
// that callers pass on every follow-up request.
function beginSession(backing: Store, sessions: Map<string, Session>): string {
  const id = `sess_${sessions.size}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let settle!: (commit: boolean) => void;
  const gate = new Promise<void>((resolve, reject) => {
    settle = (commit) =>
      commit ? resolve() : reject(new Error('transaction rolled back'));
  });
  // Record the session from inside the transaction body so it captures the unit. `done` starts as
  // a placeholder because the transaction promise does not exist yet. The line below overwrites it,
  // and nothing reads `done` before then.
  const done = backing
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
    const posting = await ledger.posting(body.txnId as string);
    return posting === null ? null : encodeWire.posting(posting);
  }
  return ledgerReadRoute(ledger, method, body);
}

// Handles the remaining ledger reads, split out to keep each function short. `statement` returns
// one page. `heads`, `timeline`, `lineage`, and `list` stream rows one at a time, so each one
// collects into an array here.
async function ledgerReadRoute(
  ledger: Store['ledger'],
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'statement') {
    const range = body.range as { from: number; to: number };
    const statement = await ledger.statement(body.account as AccountRef, range);
    return { ...statement, entries: statement.entries.map(encodeEntry) };
  }
  if (method === 'heads') {
    return collect(ledger.heads(), (head) => head as unknown);
  }
  if (method === 'balanceAccounts') {
    return collect(ledger.balanceAccounts(), (account) => account as unknown);
  }
  if (method === 'timeline') {
    // Pass the order and limit straight through to the backing ledger. The engine then bounds its
    // own DB work, instead of fetching every row and trimming the result here.
    const timelineOptions = {
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
  const rows: unknown[] = [];
  for await (const item of source) {
    rows.push(map(item));
  }
  return rows;
}

// --- Sub-store routes -------------------------------------------------------------

// Picks the unit for a request. Session id 'root' means a call outside any transaction. The
// backing store exposes the same sub-stores a unit does, so it stands in directly. Any other id
// uses the unit captured for that session.
function unitFor(
  backing: Store,
  sessions: Map<string, Session>,
  session: string,
): Unit {
  return session === 'root' ? backing : sessions.get(session)!.unit;
}

async function subStoreRoute(
  unit: Unit,
  store: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const handler = SUBSTORE_ROUTES[`${store}/${method}`];
  if (!handler) {
    throw new Error(`unknown route ${store}/${method}`);
  }
  return handler(unit, body);
}

type SubHandler = (
  unit: Unit,
  body: Record<string, unknown>,
) => Promise<unknown>;

// Holds every non-ledger sub-store call, with one entry per method. Each handler decodes the
// body's wire form to domain values, calls the store method, and encodes the result back. The
// client has a matching call for every entry.
const SUBSTORE_ROUTES: Record<string, SubHandler> = {
  'idempotency/claim': async (unit, body) => {
    const result = await unit.idempotency.claim(body.key as string);
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
    const sale = await unit.sales.get(body.orderId as string);
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
    const stored = await unit.inbox.enqueueInbound(
      decodeWire.inboxEntry(body.entry),
    );
    return encodeWire.inboxEntry(stored);
  },
  'inbox/claimInbound': async (unit, body) => {
    const pending = await unit.inbox.claimInbound(
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
    const saga = await unit.sagas.load(body.id as string);
    return saga === null ? null : encodeWire.saga(saga);
  },
  'sagas/list': (unit) => collect(unit.sagas.list(), encodeWire.saga),
  'sagas/claimDue': async (unit, body) => {
    const due = await unit.sagas.claimDue(
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
    const sub = await unit.subscriptions.load(body.id as string);
    return sub === null ? null : encodeWire.subscription(sub);
  },
  'subscriptions/activeFor': async (unit, body) => {
    const sub = await unit.subscriptions.activeFor(
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
    const due = await unit.subscriptions.claimDue(
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
    const due = await unit.promos.claimDue(
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

// Decodes a saga patch. A saga is a long-running multi-step payout tracked across states. The
// patch updates only some fields, so its money field `reserve` may be absent. Decode `reserve`
// from its wire string only when present, and pass the rest of the patch through unchanged.
function decodeSagaPatch(
  patch: unknown,
): Parameters<Unit['sagas']['advance']>[3] {
  const row = { ...(patch as Record<string, unknown>) };
  // The amount-typed fields `reserve` and `payoutUsd` ride the wire as encoded strings. Decode
  // them back to Amounts, and let every other field pass through. `payoutUsd` is null before
  // settlement, so decode it only when it is an actual encoded-amount string.
  if (typeof row.reserve === 'string') {
    row.reserve = decodeWire.amount(row.reserve);
  }
  if (typeof row.payoutUsd === 'string') {
    row.payoutUsd = decodeWire.amount(row.payoutUsd);
  }
  return row as Parameters<Unit['sagas']['advance']>[3];
}

// --- Routes that bypass transactions (trust, checkpoints) -------------------------
// The trust store keeps a running per-subject tally of recent spend for risk checks. It and the
// checkpoints write directly on the backing store, not inside a held transaction. So these routes
// take the store rather than a session's unit.

async function trustRoute(
  backing: Store,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'read') {
    const velocity = await backing.trust.read(body.subject as string);
    return { ...velocity, spent: encodeWire.amount(velocity.spent) };
  }
  const wireAttempt = body.attempt as Record<string, unknown>;
  const attempt = {
    ...wireAttempt,
    amount: decodeWire.amount(wireAttempt.amount),
  } as Parameters<typeof backing.trust.bump>[1];

  if (method === 'record') {
    const velocity = await backing.trust.record(
      body.subject as string,
      attempt,
    );
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

// The webhook replay store deduplicates incoming events. Claiming an event id succeeds the first
// time and fails on repeats. The claim runs directly on the backing store, never inside a held
// transaction, because webhook ingress checks it before doing any work, so this route takes the
// store. Only `claim` exists, and its `{ claimed }` result is plain JSON that needs no codec.
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

// @see https://economy-lab-docs.pages.dev/economy/reference/http-service/
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
  const session = segments[1]!;
  const tail = segments.slice(2);
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
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   the request protocol and route map.
 */
export function createStoreServer(
  backing: Store,
): (request: Request) => Promise<Response> {
  const sessions = new Map<string, Session>();
  return async (request) => {
    const segments = new URL(request.url).pathname.split('/').filter(Boolean);
    const body = (await readBody(request)) as Record<string, unknown>;
    try {
      const result = await dispatch(backing, sessions, segments, body);
      return jsonResponse({ ok: true, body: result ?? null });
    } catch (error) {
      return jsonResponse({ ok: false, error: messageOf(error) });
    }
  };
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
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
