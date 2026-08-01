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
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type {
  EconomyClient,
  EconomyStore,
  ListKey,
  ListReadState,
  ReadKey,
  ReadState,
  SubmitOptions,
  WireOutcome,
  WirePage,
} from './core.js';

const Context = createContext<EconomyStore | null>(null);

/** Puts the store in scope for the hooks. Build it once with `economyClient(...)`. */
export function EconomyProvider(props: {
  readonly client: EconomyStore;
  readonly children?: ReactNode;
}) {
  return (
    <Context.Provider value={props.client}>{props.children}</Context.Provider>
  );
}

/** Exactly { data, error, refresh } — a hook reads; it never submits. */
export interface ReadHookResult<T> extends ReadState<T> {
  refresh(): Promise<void>;
}

/**
 * A list hook: the same three, plus the window. `data.items` is every item loaded so far,
 * and `loadMore` only ever adds to it.
 */
export interface ListHookResult<T> extends ReadHookResult<WirePage<T>> {
  /** Reads one more page into `data.items`. Resolves without a read once `hasMore` is false. */
  loadMore(): Promise<void>;
  /** Whether another `loadMore()` would fetch anything. */
  readonly hasMore: boolean;
  /** True while a `loadMore()` is in flight; a plain `refresh()` leaves it false. */
  readonly loadingMore: boolean;
}

// The refusal names the hook the caller wrote, never this helper.
function useStore(key: ReadKey): EconomyStore {
  const store = useContext(Context);
  if (!store) {
    throw new Error(
      `use${key[0]!.toUpperCase()}${key.slice(1)}() needs an <EconomyProvider> above it`,
    );
  }
  return store;
}

/**
 * The store the provider above holds. The read and write hooks cover the money loop; this is
 * the door for the rest of the store's own surface — `settled()` before navigating away,
 * `resume()` from a re-authentication button, `client` for a read the hooks do not map.
 * Returns the same object the host built, so it is stable across renders.
 */
export function useEconomyStore(): EconomyStore {
  const store = useContext(Context);
  if (!store) {
    throw new Error('useEconomyStore() needs an <EconomyProvider> above it');
  }
  return store;
}

function useRead<T>(key: ReadKey): ReadHookResult<T> {
  const store = useStore(key);
  const state = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => store.subscribe(key, onChange),
      [store, key],
    ),
    () => store.read(key),
    () => store.read(key),
  ) as ReadState<T>;
  const refresh = useCallback(() => store.refresh(key), [store, key]);
  return { data: state.data, error: state.error, refresh };
}

// The paging facts come off the store snapshot, not a local useState: getSnapshot must
// return the same object until something changes, and one key is one shared subscription.
function useList<T>(key: ListKey): ListHookResult<T> {
  const store = useStore(key);
  const state = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => store.subscribe(key, onChange),
      [store, key],
    ),
    () => store.readPage(key),
    () => store.readPage(key),
  ) as ListReadState<T>;
  const refresh = useCallback(() => store.refresh(key), [store, key]);
  const loadMore = useCallback(() => store.loadMore(key), [store, key]);
  return {
    data: state.data,
    error: state.error,
    refresh,
    loadMore,
    hasMore: state.hasMore,
    loadingMore: state.loadingMore,
  };
}

type Read<M extends keyof EconomyClient> = Awaited<
  ReturnType<EconomyClient[M]>
>;
type Item<M extends ListKey> = Read<M> extends WirePage<infer T> ? T : never;

export interface SubmitHookResult {
  /**
   * POST the body to the host's route named at the hook, and resolve with the envelope. A
   * rejected outcome resolves like any other — a "no" is data. A reply that is not an
   * envelope at all is transport: the promise rejects with `EconomyHttpError`, carrying the
   * status and body. Await it or catch it; a call whose promise nobody takes discards the
   * failure, and a 5xx on a checkout is not a failure to discard.
   */
  submit(body: unknown, options?: SubmitOptions): Promise<WireOutcome>;
  /** True while this hook instance has a submit in flight. */
  pending: boolean;
  /** The last envelope this instance received, rejection union untouched. */
  lastOutcome: WireOutcome | undefined;
}

/**
 * The write door of the money loop: submits through the HOST's own route (its auth, its
 * pricing), then the mapped reads refetch — `OUTCOME_READS[kind]`, nothing else.
 * Concurrent submits on one instance run in order. Client-only, like every hook here.
 */
export function useSubmit(path: string): SubmitHookResult {
  const store = useContext(Context);
  if (!store)
    throw new Error('useSubmit() needs an <EconomyProvider> above it');
  const [pending, setPending] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<WireOutcome | undefined>(
    undefined,
  );
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  const submit = useCallback(
    (body: unknown, options?: SubmitOptions) => {
      inFlight.current += 1;
      setPending(true);
      const run = queue.current.then(() =>
        store.submitRoute(path, body, options),
      );
      queue.current = run.catch(() => undefined);
      return run
        .then((outcome) => {
          setLastOutcome(outcome);
          return outcome;
        })
        .finally(() => {
          inFlight.current -= 1;
          if (inFlight.current === 0) setPending(false);
        });
    },
    [store, path],
  );
  return { submit, pending, lastOutcome };
}

/** GET /v1/wallet — `client.wallet()`. One object, so no list and no paging. */
export const useWallet = () => useRead<Read<'wallet'>>('wallet');
/** GET /v1/entitlements — `client.entitlements()`, a window at a time. */
export const useEntitlements = () =>
  useList<Item<'entitlements'>>('entitlements');
/** GET /v1/subscriptions — `client.subscriptions()`, a window at a time. */
export const useSubscriptions = () =>
  useList<Item<'subscriptions'>>('subscriptions');
/** GET /v1/payouts — `client.payouts()`, a window at a time. */
export const usePayouts = () => useList<Item<'payouts'>>('payouts');
