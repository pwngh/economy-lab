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
import {
  ERROR_CODES,
  EconomyError,
  fault,
  normalizeError,
} from '#src/errors.ts';

import type { AccountRef } from '#src/accounts.ts';
import type {
  AccrualRow,
  Reproof,
  SagaState,
  Store,
  Unit,
  Velocity,
} from '#src/ports.ts';

// A name the route table does not have. Typed here rather than thrown raw, because normalizeError
// cannot classify a raw throw and answers `retryable: true` for it — which would tell a client to
// keep retrying a route that will never exist. The message names the route so an operator can see
// which half of the protocol is behind.
function unknownRoute(name: string): EconomyError {
  return fault(ERROR_CODES.UNKNOWN_ROUTE, `unknown route ${name}`, {
    retryable: false,
  });
}

// Holds a db transaction open across several requests. The transaction body pauses on a promise
// called the gate, so later requests run inside it before it commits or rolls back.
type Session = {
  unit: Unit;

  settle: (commit: boolean) => void;

  // Resolves once the db transaction has committed or rolled back. Awaiting surfaces any
  // commit-time error.
  done: Promise<void>;
};

// --- Session lifecycle ------------------------------------------------------------

// Opens a db transaction paused on the gate. The commit and rollback routes settle it. Returns
// the session id callers pass on every follow-up request.
async function beginSession(
  backing: Store,
  sessions: Map<string, Session>,
): Promise<string> {
  // size alone can repeat after deletes. The timestamp + random tail make the id unique.
  const id = `sess_${sessions.size}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let settle!: (commit: boolean) => void;
  const gate = new Promise<void>((resolve, reject) => {
    settle = (commit) =>
      commit ? resolve() : reject(new Error('transaction rolled back'));
  });
  // Record the session from inside the transaction body so it captures the unit. `done` starts as
  // a placeholder because the transaction promise does not exist yet. The code below patches it
  // in once the body has registered.
  let register!: () => void;
  const registered = new Promise<void>((resolve) => (register = resolve));
  const done = backing
    .transaction(async (unit) => {
      sessions.set(id, {
        unit,
        settle,
        done: undefined as unknown as Promise<void>,
      });
      register();
      await gate;
    })
    .then(() => undefined);
  // A rollback rejects this promise, so catch it here to avoid an unhandled rejection. The
  // rollback route succeeds either way. Commit-time errors still surface because the commit
  // route awaits `done` directly.
  done.catch(() => {});
  // The body may start asynchronously (the memory store queues overlapping callers), so wait
  // for it to register the unit. If `done` settles first, the transaction never got there.
  await Promise.race([registered, done]);
  const session = sessions.get(id);
  if (!session) {
    throw new Error('transaction ended before its session registered');
  }
  session.done = done;
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

// Every router below resolves its method by name and refuses anything else. A trailing arm that
// ran the last handler for an unrecognized name answered a renamed or dropped route with another
// route's result instead of failing.
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
  if (method === 'links') {
    return ledger.links(body.txnId as string);
  }
  if (method === 'linksPage') {
    const page = await ledger.linksPage(
      body.cursor as number | null,
      body.limit as number,
    );
    return {
      cursor: page.cursor,
      links: page.links.map((link) => ({
        ...link,
        legs: link.legs.map((leg) => ({
          account: leg.account,
          amount: encodeWire.amount(leg.amount),
        })),
      })),
    };
  }
  return ledgerReadRoute(ledger, method, body);
}

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
  if (method === 'derivedBalances') {
    const derived = await ledger.derivedBalances(body.account as AccountRef);
    return derived.map((amount) => encodeWire.amount(amount));
  }
  if (method === 'heads') {
    return collect(ledger.heads(), (head) => head as unknown);
  }
  if (method === 'headSums') {
    // The bigint sum travels as a decimal string. The client re-widens it.
    return collect(
      ledger.headSums(),
      ([account, head, sum]) => [account, head, sum.toString()] as unknown,
    );
  }
  if (method === 'balanceAccounts') {
    return collect(ledger.balanceAccounts(), (account) => account as unknown);
  }
  if (method === 'timeline') {
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
  if (method === 'lineage') {
    return collect(
      ledger.lineage(body.account as AccountRef, {
        sinceHash: body.sinceHash as string | undefined,
      }),
      (link) => ({
        ...link,
        legs: link.legs.map((leg) => ({
          account: leg.account,
          amount: encodeWire.amount(leg.amount),
        })),
      }),
    );
  }
  throw unknownRoute(`ledger/${method}`);
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

// The open transaction an id names. The map is per-process and holds only ids this process minted
// and has not settled, so a restart, a second instance behind a load balancer, and an already
// committed or rolled back id all land here, and none of them ever resolves on a retry.
function sessionFor(sessions: Map<string, Session>, id: string): Session {
  const session = sessions.get(id);
  if (!session) {
    throw fault(ERROR_CODES.UNKNOWN_SESSION, `unknown transaction ${id}`, {
      retryable: false,
    });
  }
  return session;
}

// Picks the unit for a request. Session id 'root' means a call outside any transaction. The
// backing store exposes the same sub-stores a unit does, so it stands in directly. Any other id
// uses the unit captured for that session.
function unitFor(
  backing: Store,
  sessions: Map<string, Session>,
  session: string,
): Unit {
  return session === 'root' ? backing : sessionFor(sessions, session).unit;
}

async function subStoreRoute(
  unit: Unit,
  route: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const handler = SUBSTORE_ROUTES[route];
  if (!handler) {
    throw unknownRoute(route);
  }
  return handler(unit, body);
}

type SubHandler = (
  unit: Unit,
  body: Record<string, unknown>,
) => Promise<unknown>;

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
  'outbox/bumpAttempt': (unit, body) =>
    unit.outbox.bumpAttempt(body.id as string),
  'outbox/deadLetter': async (unit, body) => {
    await unit.outbox.deadLetter(body.id as string, body.reason as string);
    return null;
  },
  'outbox/stats': (unit) => unit.outbox.stats(),
  'inbox/enqueueInbound': async (unit, body) => {
    const stored = await unit.inbox.enqueueInbound(
      decodeWire.inboxMessage(body.entry),
    );
    return encodeWire.inboxMessage(stored);
  },
  'inbox/claimInbound': async (unit, body) => {
    const pending = await unit.inbox.claimInbound(
      body as Parameters<typeof unit.inbox.claimInbound>[0],
    );
    return pending.map(encodeWire.inboxMessage);
  },
  'inbox/markApplied': async (unit, body) => {
    await unit.inbox.markApplied(body.id as string);
    return null;
  },
  'inbox/bumpAttempt': (unit, body) =>
    unit.inbox.bumpAttempt(body.id as string),
  'inbox/deadLetter': async (unit, body) => {
    await unit.inbox.deadLetter(body.id as string, body.reason as string);
    return null;
  },
  'inbox/reviveDead': async (unit, body) => {
    const revived = await unit.inbox.reviveDead(body.limit as number);
    return revived.map(encodeWire.inboxMessage);
  },
  'sagas/open': async (unit, body) => {
    await unit.sagas.open(decodeWire.saga(body.saga));
    return null;
  },
  'sagas/load': async (unit, body) => {
    const saga = await unit.sagas.load(body.id as string);
    return saga === null ? null : encodeWire.saga(saga);
  },
  'sagas/findByProviderRef': async (unit, body) => {
    const saga = await unit.sagas.findByProviderRef(body.providerRef as string);
    return saga === null ? null : encodeWire.saga(saga);
  },
  'sagas/list': (unit, body) =>
    collect(
      unit.sagas.list(
        body.states === undefined && body.userId === undefined
          ? undefined
          : {
              ...(body.states === undefined
                ? {}
                : { states: body.states as SagaState[] }),
              ...(body.userId === undefined
                ? {}
                : { userId: body.userId as string }),
            },
      ),
      encodeWire.saga,
    ),
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
      body.expectAttempts === undefined
        ? undefined
        : { expectAttempts: body.expectAttempts as number },
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
    await unit.entitlements.revoke(body.userId as string, body.sku as string, {
      source: body.source as string | undefined,
    });
    return null;
  },
  'entitlements/owns': (unit, body) =>
    unit.entitlements.owns(body.userId as string, body.sku as string),
  'entitlements/list': (unit, body) =>
    collect(unit.entitlements.list(body.userId as string), (g) => g as unknown),
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
  'subscriptions/listFor': async (unit, body) => {
    const out: unknown[] = [];
    for await (const sub of unit.subscriptions.listFor(body.userId as string)) {
      out.push(encodeWire.subscription(sub));
    }
    return out;
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
  'promos/liveFor': async (unit, body) => {
    const live = await unit.promos.liveFor(body.userId as string);
    return live.map(encodeWire.promoGrant);
  },
  'promos/holders': (unit) =>
    collect(unit.promos.holders(), (userId) => userId as unknown),
  'promos/markReversed': async (unit, body) => {
    await unit.promos.markReversed(body.id as string);
    return null;
  },
  'accruals/put': async (unit, body) => {
    await unit.accruals.put(
      (body.rows as unknown[]).map((row) => decodeAccrualRow(row)),
    );
    return null;
  },
  'accruals/claimByOrder': async (unit, body) =>
    (await unit.accruals.claimByOrder(body.orderId as string)).map(
      encodeAccrualRow,
    ),
  'accruals/pendingSellers': (unit, body) =>
    unit.accruals.pendingSellers(body.limit as number),
  'accruals/claimPendingBySeller': async (unit, body) =>
    (
      await unit.accruals.claimPendingBySeller(
        body.sellerId as string,
        body.limit as number,
      )
    ).map(encodeAccrualRow),
  'accruals/markDrained': async (unit, body) => {
    await unit.accruals.markDrained(
      body.keys as Parameters<Unit['accruals']['markDrained']>[0],
      body.txnId as string,
    );
    return null;
  },
  'accruals/markRefunded': async (unit, body) => {
    await unit.accruals.markRefunded(
      body.keys as Parameters<Unit['accruals']['markRefunded']>[0],
      body.txnId as string,
    );
    return null;
  },
  'accruals/stats': async (unit) => {
    const stats = await unit.accruals.stats();
    // bigint can't ride JSON. The client decodes the string back.
    return { ...stats, pendingMinor: stats.pendingMinor.toString() };
  },
  'accruals/netPending': async (unit, body) =>
    (await unit.accruals.netPending(body.sellerId as string)).toString(),
};

// The amount is the row's only Amount-typed field. Everything else is JSON-safe as is. These
// codecs must stay wire-compatible with the client copies in http.ts.
function encodeAccrualRow(row: AccrualRow): Record<string, unknown> {
  return { ...row, amount: encodeWire.amount(row.amount) };
}

function decodeAccrualRow(wire: unknown): AccrualRow {
  const row = wire as Record<string, unknown>;
  return {
    ...(row as unknown as AccrualRow),
    amount: decodeWire.amount(row.amount),
  };
}

function decodeSagaPatch(
  patch: unknown,
): Parameters<Unit['sagas']['advance']>[3] {
  const row = { ...(patch as Record<string, unknown>) };
  // The amount-typed fields `reserve` and `payoutUsd` ride the wire as encoded strings. Decode
  // them back to Amounts, and let every other field pass through. `payoutUsd` can be null on
  // rows from before pricing-at-request, so decode it only when it is an encoded-amount string.
  if (typeof row.reserve === 'string') {
    row.reserve = decodeWire.amount(row.reserve);
  }
  if (typeof row.payoutUsd === 'string') {
    row.payoutUsd = decodeWire.amount(row.payoutUsd);
  }
  return row as Parameters<Unit['sagas']['advance']>[3];
}

// --- Routes that bypass transactions (trust, checkpoints) -------------------------
// These write directly on the backing store, never inside a held transaction, so they take the
// store rather than a session's unit.

function decodeAttempt(
  body: Record<string, unknown>,
): Parameters<Store['trust']['bump']>[1] {
  const wire = body.attempt as Record<string, unknown>;
  return {
    ...wire,
    amount: decodeWire.amount(wire.amount),
  } as Parameters<Store['trust']['bump']>[1];
}

function encodeVelocity(velocity: Velocity): unknown {
  return { ...velocity, spent: encodeWire.amount(velocity.spent) };
}

async function trustRoute(
  backing: Store,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'read') {
    return encodeVelocity(await backing.trust.read(body.subject as string));
  }
  if (method === 'record') {
    return encodeVelocity(
      await backing.trust.record(body.subject as string, decodeAttempt(body)),
    );
  }
  if (method === 'bump') {
    await backing.trust.bump(body.subject as string, decodeAttempt(body));
    return null;
  }
  throw unknownRoute(`trust/${method}`);
}

async function movementRoute(
  backing: Store,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'append') {
    await backing.movements.append(
      (body.movements as unknown[]).map((row) => decodeWire.movement(row)),
    );
    return null;
  }
  if (method === 'bySession') {
    return collect(
      backing.movements.bySession(body.sessionId as string),
      (movement) => encodeWire.movement(movement),
    );
  }
  throw unknownRoute(`movements/${method}`);
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
  if (method === 'reproof') {
    return (await backing.checkpoints.reproof?.()) ?? null;
  }
  if (method === 'putReproof') {
    await backing.checkpoints.putReproof?.(body.state as Reproof);
    return null;
  }
  if (method === 'latest') {
    return backing.checkpoints.latest();
  }
  throw unknownRoute(`checkpoints/${method}`);
}

// The drain sweep starts from these out-of-transaction accrual reads (work list and backlog
// gauge). The claims and marks stay session-scoped.
async function accrualRoute(
  backing: Store,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'pendingSellers') {
    return backing.accruals.pendingSellers(body.limit as number);
  }
  if (method === 'stats') {
    const stats = await backing.accruals.stats();
    return { ...stats, pendingMinor: stats.pendingMinor.toString() };
  }
  if (method === 'netPending') {
    return (
      await backing.accruals.netPending(body.sellerId as string)
    ).toString();
  }
  throw unknownRoute(`accruals/${method}`);
}

async function replayRoute(
  backing: Store,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'claim') {
    return backing.replay.claim(body.eventId as string);
  }
  throw unknownRoute(`replay/${method}`);
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
  if (segments[0] === 'movements') {
    return movementRoute(backing, segments[1]!, body);
  }
  if (segments[0] === 'replay') {
    return replayRoute(backing, segments[1]!, body);
  }
  if (segments[0] === 'accruals') {
    return accrualRoute(backing, segments[1]!, body);
  }
  if (segments[0] === 'close') {
    await backing.close();
    return null;
  }
  throw fault(
    ERROR_CODES.UNKNOWN_ROUTE,
    `unknown path /${segments.join('/')}`,
    { retryable: false },
  );
}

async function txDispatch(
  backing: Store,
  sessions: Map<string, Session>,
  segments: string[],
  body: Record<string, unknown>,
): Promise<unknown> {
  if (segments[1] === 'begin') {
    return { session: await beginSession(backing, sessions) };
  }
  // Anything after `tx` that is not `begin` is read as a session id, so a misspelled `begin`
  // arrives here as a transaction nobody opened.
  const session = segments[1]!;
  const tail = segments.slice(2);
  if (tail[0] === 'commit') {
    await commitSession(sessionFor(sessions, session));
    sessions.delete(session);
    return null;
  }
  if (tail[0] === 'rollback') {
    await rollbackSession(sessionFor(sessions, session));
    sessions.delete(session);
    return null;
  }
  if (tail[0] === 'ledger') {
    return ledgerRoute(
      unitFor(backing, sessions, session).ledger,
      tail[1]!,
      body,
    );
  }
  return subStoreRoute(
    unitFor(backing, sessions, session),
    tail.join('/'),
    body,
  );
}

// --- The Fetch handler ------------------------------------------------------------

/**
 * Build the server side of the HTTP store adapter. It is a {@link Request} -> {@link Response}
 * function that answers each request against the backing {@link Store}.
 *
 * Success sends `{ ok: true, body }`. A thrown handler sends `{ ok: false, error }` with the
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
      // The stable code and retryable flag cross the wire so the client rebuilds an equivalent
      // EconomyError. `detail` is for server logs only and deliberately stays off the wire.
      const normalized = EconomyError.is(error) ? error : normalizeError(error);
      return jsonResponse({
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
        },
      });
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
