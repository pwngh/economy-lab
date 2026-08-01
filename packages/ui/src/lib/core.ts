/**
 * @pwngh/economy-ui
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import {
  createClient,
  createTransport,
  EconomyHttpError,
  newIdempotencyKey,
} from '@pwngh/economy-client';
import { OUTCOME_READS } from '@pwngh/economy-core/module';
import { joinUrl, wireRowIdentity } from '@pwngh/economy-lab/client';
import type { TokenSource } from '@pwngh/economy-client';
import type {
  EconomyClient,
  WireOperation,
  WireOutcome,
  WirePage,
} from '@pwngh/economy-lab/client';

export type {
  EconomyClient,
  WireAmount,
  WireOperation,
  WireOutcome,
  WirePage,
} from '@pwngh/economy-lab/client';

/** The four read resources; each compiles to exactly one client read (the README table). */
export const READ_KEYS = [
  'wallet',
  'entitlements',
  'subscriptions',
  'payouts',
] as const;
export type ReadKey = (typeof READ_KEYS)[number];

/** The three reads that answer a page. `wallet` is one object and has no list. */
export const LIST_KEYS = ['entitlements', 'subscriptions', 'payouts'] as const;
export type ListKey = (typeof LIST_KEYS)[number];

/** The most items one `/v1` list read hands back — the route caps `?limit=` here. */
export const MAX_WINDOW = 200;

/** The wire's own default page, so an unset `pageSize` asks for what the route would give. */
const DEFAULT_PAGE = 50;

const DEFAULT_POLL_MS = 15_000;

/** The longest wait a timer holds; `setInterval` answers anything above it every millisecond. */
const MAX_POLL_MS = 2_147_483_647;

/** A read's current snapshot: last good data plus the last error, either side undefined. */
export interface ReadState<T = unknown> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
}

/**
 * A list read's snapshot. `data` is the whole loaded window, so a page that lands adds to it
 * rather than replacing it, and `hasMore` says whether another `loadMore()` would fetch any.
 */
export interface ListReadState<T = unknown> extends ReadState<WirePage<T>> {
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
}

export interface EconomyStoreOptions {
  /**
   * Where the economy answers, e.g. `https://api.example.com`, or `/` for the page's own origin.
   * A trailing slash is fine — `submitRoute` joins it to the route path with exactly one slash
   * between them, so no base can turn a route path into a URL naming another host.
   */
  readonly baseUrl: string;
  /**
   * The bearer, fixed or read per request. In a browser this is only ever a user token. A
   * function is called on every request, so a session that rotates its token outlives the store
   * that was built around it. Minting the next one is the host application's business: this
   * package never holds a refresh token.
   */
  readonly token?: string | TokenSource;
  readonly fetch?: typeof fetch;
  /** Extra headers on every request, e.g. a tracing id. A non-empty bearer wins `authorization`. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Poll cadence in milliseconds while a key has subscribers. Default 15_000. Polling needs a
   * positive finite cadence: `false`, `0`, a negative and a non-finite value all mean off. A
   * cadence longer than a timer can hold waits the longest it can rather than firing
   * continuously, which is what an overflowed `setInterval` does.
   */
  readonly pollMs?: number | false;
  /** Items a list read asks for, and the step `loadMore` widens by. Default 50, ceiling 200. */
  readonly pageSize?: number;
  /**
   * Called when a read or a write answers 401 and the store parks. Fires once per park, not
   * once per key and not once per poll tick, so four keys polling do not become four prompts.
   * Minting the next bearer is the host application's business; call `resume()` once it has.
   */
  readonly onUnauthorized?: (error: EconomyHttpError) => void;
}

export interface SubmitOptions {
  /** Omitted mints a fresh key, so one call is one attempt. */
  readonly idempotencyKey?: string;
}

export interface EconomyStore {
  /** The wrapped lab client, for the reads the hooks don't cover. */
  readonly client: EconomyClient;
  /** The current snapshot; stable between changes, so it can back useSyncExternalStore. */
  read(key: ReadKey): ReadState;
  /** The same snapshot for a list key, with the paging facts on it. */
  readPage(key: ListKey): ListReadState;
  /** First subscriber starts the key's poll; the last one leaving stops it. A subscriber
   *  reads unless the key already holds data, so a key whose last read failed is read
   *  again — an error is not a loaded state. */
  subscribe(key: ReadKey, listener: () => void): () => void;
  /** One client read now, at the window the key currently holds. A caller asking for exactly
   *  the read already out joins it; anything else queues behind it. */
  refresh(key: ReadKey): Promise<void>;
  /** Reads the page after the one the list ends on and appends it. A no-op once `hasMore` is
   *  false, and a second call during a flight joins that flight rather than starting another. */
  loadMore(key: ListKey): Promise<void>;
  /** The lab write door, then the semantic refetch: exactly the reads OUTCOME_READS
   *  names for the committed kind. A rejection refetches nothing. */
  submit(operation: WireOperation): Promise<WireOutcome>;
  /** POSTs a body to the host's own route and treats the reply as the submit envelope —
   *  the browser-lawful write path. The path joins `baseUrl` with exactly one slash between
   *  them, so `'/'` and `'/checkout'` post to `/checkout` rather than to the host `checkout`.
   *  The key defaults to a fresh `newIdempotencyKey()`, so one call is one attempt; pass a
   *  stable key to make retries at-most-once. A non-2xx reply is transport, not outcome, and
   *  throws `EconomyHttpError` carrying the status and body. */
  submitRoute(
    path: string,
    body: unknown,
    options?: SubmitOptions,
  ): Promise<WireOutcome>;
  /** Resolves once every read this store has already started has landed — the refetches a
   *  committed write schedules included, which the write's own promise does not wait for.
   *  Write, await this, then navigate. It answers for the work outstanding when it was
   *  called: with polling on, a tick can start another read the moment it resolves. */
  settled(): Promise<void>;
  /** Clears a park and reads every key that has subscribers, at the width it holds, restarting
   *  the polls the park stopped. A fourth trigger beside subscribing, the poll tick and
   *  `refresh()` — not a retry policy: the store still keeps no timer of its own. Loaded pages
   *  survive, and calling it when nothing is parked reads nothing. */
  resume(): void;
  /** Stops every poll timer and refuses every later read, including `refresh` and `loadMore`.
   *  Subscribers stay attached and nothing refreshes them. */
  close(): void;
}

const EMPTY: ReadState = Object.freeze({ data: undefined, error: undefined });
const EMPTY_PAGE: ListReadState = Object.freeze({
  data: undefined,
  error: undefined,
  hasMore: false,
  loadingMore: false,
});

const isList = (key: ReadKey): key is ListKey => key !== 'wallet';

// Anything a structural walk may descend into. An Error is excluded on purpose: its own
// fields are not enumerable, so walking one would call every failure equal to every other.
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !(value instanceof Error)
    ? (value as Record<string, unknown>)
    : null;

// Whether two snapshots say the same thing. The payload under them is parsed JSON — plain
// objects, arrays and primitives — so the walk is total over it, and an error is compared by
// the two fields a consumer can read off it, which is what makes a poll against a cold
// backend stop re-rendering the page it already rendered.
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (a instanceof Error && b instanceof Error)
    return a.name === b.name && a.message === b.message;
  const left = asRecord(a);
  const right = asRecord(b);
  if (left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => same(left[key], right[key]))
  );
};

// Keeps the first appearance of every identified row, on the field the wire itself drew the
// list's cursor from. Two reads of one list overlap whenever rows moved between them, and a row
// the reader can see twice is worse than one read again.
const distinct = <T>(list: ListKey, rows: readonly T[]): T[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = wireRowIdentity(list, row);
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The core: `createClient` plus per-key polling, windowed lists, and invalidate-on-write. */
export function economyClient(options: EconomyStoreOptions): EconomyStore {
  // One credential-stamping transport for both write paths: the client's wire calls, and the
  // host-route POST that is not part of the wire contract but takes the same session.
  const transport = createTransport(options);
  const client = createClient({ baseUrl: options.baseUrl, fetch: transport });
  // A poll needs a positive finite cadence; everything else is off. `setInterval` treats 0, a
  // negative, a non-finite value and anything past its 32-bit ceiling as "every millisecond",
  // so the spellings a developer reaches for to mean "rarely" or "never" would each open a
  // continuous stream of authenticated reads from every mounted component.
  const cadence = options.pollMs ?? DEFAULT_POLL_MS;
  const pollMs =
    typeof cadence === 'number' && Number.isFinite(cadence) && cadence >= 1
      ? Math.min(cadence, MAX_POLL_MS)
      : false;
  // A junk page size collapses to the default and an oversized one caps, as the route does.
  const asked = options.pageSize ?? DEFAULT_PAGE;
  const pageSize =
    Number.isSafeInteger(asked) && asked >= 1
      ? Math.min(asked, MAX_WINDOW)
      : DEFAULT_PAGE;

  // The one read per key — the whole hook→wire mapping. A list read takes the window width and
  // the cursor it resumes after, if any.
  const reads: Record<
    ReadKey,
    (width: number, from?: string) => Promise<unknown>
  > = {
    wallet: () => client.wallet(),
    entitlements: (width, from) => client.entitlements(undefined, width, from),
    subscriptions: (width, from) =>
      client.subscriptions(undefined, { limit: width, cursor: from }),
    payouts: (width, from) =>
      client.payouts(undefined, { limit: width, cursor: from }),
  };

  interface Entry {
    state: ReadState;
    listeners: Set<() => void>;
    timer: ReturnType<typeof setInterval> | null;
    inflight: Promise<void> | null;
    /** What the read in flight is asking for, so only an identical caller joins it. */
    shape: string | null;
    /** Lists: how many items a fresh read re-asks for, capped at what one read can answer. */
    window: number;
    /** Lists: the resuming read in flight, so a second `loadMore` joins it. */
    more: Promise<void> | null;
  }
  // Everything the store has started and not finished, so `settled()` has something to wait on.
  // A poll tick, a subscriber's first read and the refetch a write schedules are all reads no
  // caller holds a handle to. A chain that starts another read adopts it, so one entry covers
  // the whole run.
  const pending = new Set<Promise<void>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    const done = work.then(
      () => undefined,
      () => undefined,
    );
    pending.add(done);
    void done.then(() => pending.delete(done));
    return work;
  };

  const entries = new Map<ReadKey, Entry>();
  const entry = (key: ReadKey): Entry => {
    let e = entries.get(key);
    if (!e) {
      e = {
        state: isList(key) ? EMPTY_PAGE : EMPTY,
        listeners: new Set(),
        timer: null,
        inflight: null,
        shape: null,
        window: pageSize,
        more: null,
      };
      entries.set(key, e);
    }
    return e;
  };
  let closed = false;
  // The session died under a store that is still holding everything it loaded. Parked stops
  // reads; it never clears data, and it is cleared only by `resume()`.
  let parked = false;

  const stopTimers = (): void => {
    for (const e of entries.values()) {
      if (e.timer) clearInterval(e.timer);
      e.timer = null;
    }
  };

  // One park per death of the session. A 401 arrives on every key at once — four reads polling
  // is four refusals a second apart — and the host is being asked one question, once.
  const park = (error: unknown): void => {
    if (!EconomyHttpError.is(error) || error.status !== 401) return;
    if (parked || closed) return;
    parked = true;
    stopTimers();
    options.onUnauthorized?.(error);
  };

  // Whether a write should refetch this key. Anything a caller has read goes stale, watched or
  // not: a store driven by `refresh` and `read` alone has no listeners, and the balance it
  // holds is just as wrong after a purchase as the one a hook is rendering. A key nobody has
  // read has nothing to go stale.
  const everRead = (e: Entry): boolean =>
    e.listeners.size > 0 ||
    e.inflight !== null ||
    e.state.data !== undefined ||
    e.state.error !== undefined;

  const notify = (e: Entry): void => {
    // A listener's throw stays its own — never the shared read's rejection.
    for (const l of [...e.listeners]) {
      try {
        l();
      } catch {
        /* the listener's */
      }
    }
  };

  // One page landed. A resumed read appends it. A fresh read re-reads the head of the loaded
  // list: rows past what one read covers stay, and the resume point stays with them.
  const paged = (
    list: ListKey,
    data: unknown,
    prev: ListReadState,
    from?: string,
  ): ListReadState => {
    const page = (data ?? { items: [], cursor: null }) as WirePage<unknown>;
    const landed = Array.isArray(page.items) ? page.items : [];
    const held = prev.data?.items ?? [];
    // The head the fresh read could not reach is spliced back on by position, and position is
    // only a guess: rows added or taken away server-side shift the boundary, so the read that
    // just landed can already hold rows the splice is about to add again.
    const tail =
      from === undefined && page.cursor !== null
        ? distinct(list, [...landed, ...held.slice(landed.length)]).slice(
            landed.length,
          )
        : [];
    const items =
      from === undefined
        ? [...landed, ...tail]
        : distinct(list, [...held, ...landed]);
    const cursor = tail.length > 0 ? (prev.data?.cursor ?? null) : page.cursor;
    return {
      data: { items, cursor },
      error: undefined,
      hasMore: cursor !== null,
      loadingMore: false,
    };
  };

  // The loaded pages survive a failure untouched; only the error and the flight flag move.
  const failedPage = (prev: ListReadState, error: Error): ListReadState => ({
    ...prev,
    error,
    loadingMore: false,
  });

  // One read at `width`, resuming after `from` when one is held. A caller asking for exactly
  // the read already out shares it; anyone asking for anything else queues behind it, because
  // a refresh standing in for a page leaves the head unread and a page standing in for a
  // refresh appends nothing at all. A page that lands widens the window; a failed read keeps
  // the last good page and leaves the window where it stood.
  const load = (key: ReadKey, width: number, from?: string): Promise<void> => {
    if (closed || parked) return Promise.resolve();
    const e = entry(key);
    const shape = `${width} ${from ?? ''}`;
    if (e.inflight && e.shape === shape) return e.inflight;
    const queued = e.inflight ?? Promise.resolve();
    let changed = false;
    // A read that lands what the snapshot already held is not news: keeping the object keeps
    // the `Object.is` check `useSyncExternalStore` makes, so an unchanged poll renders nothing.
    const settle = (next: ReadState): void => {
      if (same(e.state, next)) return;
      e.state = next;
      changed = true;
    };
    const flight: Promise<void> = queued
      .then(() =>
        closed
          ? undefined
          : reads[key](width, from).then(
              (data) => {
                settle(
                  isList(key)
                    ? paged(key, data, e.state as ListReadState, from)
                    : { data, error: undefined },
                );
                if (from !== undefined)
                  e.window = Math.min(e.window + width, MAX_WINDOW);
              },
              // A failed read keeps the last good data; the error rides beside it.
              (error) => {
                park(error);
                settle(
                  isList(key)
                    ? failedPage(e.state as ListReadState, error as Error)
                    : { data: e.state.data, error: error as Error },
                );
              },
            ),
      )
      .finally(() => {
        if (e.inflight === flight) {
          e.inflight = null;
          e.shape = null;
        }
      })
      .then(() => {
        if (changed) notify(e);
      });
    e.inflight = flight;
    e.shape = shape;
    return track(flight);
  };

  const refresh = (key: ReadKey): Promise<void> => load(key, entry(key).window);

  // Refetch what the kind could have changed: envelope kind, else the sent draft, else
  // every watched read. A rejection moved no money and refetches nothing.
  const invalidate = (outcome: WireOutcome, sent: unknown): void => {
    if (closed || parked || outcome.status === 'rejected') return;
    const meta = (
      outcome as { transaction?: { meta?: Record<string, unknown> } }
    ).transaction?.meta;
    const kind =
      typeof meta?.kind === 'string'
        ? meta.kind
        : typeof (sent as { kind?: unknown } | undefined)?.kind === 'string'
          ? (sent as { kind: string }).kind
          : undefined;
    // Own-property lookup: meta.kind is host data, and an inherited name ('toString')
    // must fall to the superset like any other unknown kind.
    const keys =
      kind !== undefined && Object.hasOwn(OUTCOME_READS, kind)
        ? OUTCOME_READS[kind as keyof typeof OUTCOME_READS]
        : READ_KEYS;
    // A paged list refetches at the width it holds, so every loaded page stays loaded and
    // every one of them is current. Page one is never restored under a reader who passed it,
    // and a read already out is waited on so the refetch asks at the width it settles at.
    for (const key of keys) {
      const e = entries.get(key);
      if (e === undefined || !everRead(e)) continue;
      void track(
        e.inflight ? e.inflight.then(() => refresh(key)) : refresh(key),
      );
    }
  };

  return {
    client,
    read: (key) => entry(key).state,
    // A list key seeds a ListReadState and is only ever reassigned one, so the view is total.
    readPage: (key) => entry(key).state as ListReadState,
    subscribe(key, listener) {
      const e = entry(key);
      e.listeners.add(listener);
      // An error is not a loaded state. A key whose read failed holds no data, so the next
      // subscriber reads it again — which is what makes a remount the recovery from an
      // expired token or a cold backend. Recovery is on subscribe, on the poll tick and on an
      // explicit `refresh()`; the store never retries on a timer of its own.
      const unread = e.state.data === undefined;
      if (unread && !closed && !parked) void refresh(key);
      if (!e.timer && pollMs !== false && !closed && !parked) {
        e.timer = setInterval(() => void refresh(key), pollMs);
        e.timer.unref?.();
      }
      return () => {
        e.listeners.delete(listener);
        if (e.listeners.size === 0 && e.timer) {
          clearInterval(e.timer);
          e.timer = null;
        }
      };
    },
    refresh,
    loadMore(key) {
      const e = entry(key);
      const state = e.state as ListReadState;
      if (e.more) return e.more;
      if (closed || parked || !state.hasMore) return Promise.resolve();
      const busy: ListReadState = { ...state, loadingMore: true };
      e.state = busy;
      notify(e);
      // A read already out may move where the list ends, so resume from wherever it leaves it.
      e.more = (e.inflight ?? Promise.resolve())
        .then(() => {
          const from = (e.state as ListReadState).data?.cursor;
          return from === null || from === undefined
            ? undefined
            : load(key, pageSize, from);
        })
        .finally(() => {
          e.more = null;
          // The flag goes up before the store knows a read will happen. Every path that reads
          // rewrites the state and clears it; the paths that decide not to — the list ended
          // under the flight, the store closed — leave a spinner nothing will ever stop.
          const settled = e.state as ListReadState;
          if (settled.loadingMore) {
            const idle: ListReadState = { ...settled, loadingMore: false };
            e.state = idle;
            notify(e);
          }
        });
      return track(e.more);
    },
    async submit(operation) {
      // The write path parks on the same refusal the reads do — a session dies for all of them
      // at once, and a caller who only ever writes would otherwise never hear about it.
      const outcome = await client.submit(operation).catch((error: unknown) => {
        park(error);
        throw error;
      });
      invalidate(outcome, operation);
      return outcome;
    },
    // Destructured, not named: the enclosing `economyClient` already binds `options`.
    async submitRoute(path, body, { idempotencyKey } = {}) {
      const res = await transport(joinUrl(options.baseUrl, path), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The key format is the client package's to decide, so mint it with its helper.
          'idempotency-key': idempotencyKey ?? newIdempotencyKey(),
        },
        body: JSON.stringify(body),
      });
      // The envelope answers 200 even for a "no"; anything else is transport, not outcome —
      // and it throws what the read path throws, so the reason the host gave survives. A 5xx
      // is indeterminate and is never dressed up as a rejected outcome: that would claim the
      // economy said no to a write that may well have landed.
      if (!res.ok) {
        const failure = new EconomyHttpError(res.status, await res.text());
        park(failure);
        throw failure;
      }
      const outcome = (await res.json()) as WireOutcome;
      invalidate(outcome, body);
      return outcome;
    },
    async settled() {
      // A refetch waits on the read already out, and that whole chain is one entry, so one
      // pass is the answer. What arrives after — a poll tick — is work this was not asked
      // about.
      await Promise.all([...pending]);
    },
    resume() {
      if (closed || !parked) return;
      parked = false;
      for (const [key, e] of entries) {
        if (e.listeners.size === 0) continue;
        if (!e.timer && pollMs !== false) {
          e.timer = setInterval(() => void refresh(key), pollMs);
          e.timer.unref?.();
        }
        void track(refresh(key));
      }
    },
    close() {
      closed = true;
      stopTimers();
    },
  };
}
