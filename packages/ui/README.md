# ui

Storefront hooks for [`@pwngh/economy`](../economy). Four reads, each compiling to exactly one
`/v1` call, and one write door that posts to your own route, with the lists paged and refetching
driven by what the money actually changed.

## Features

- **One read per hook:** [the expansion table](#the-expansion-table) is exhaustive — every
  hook is one client call. `useWallet()` returns `{ data, error, refresh }`; the three list
  hooks add `loadMore`, `hasMore`, and `loadingMore`, and nothing else.
- **Lists page:** a hundred entitlements or a year of payouts arrive [a window at a
  time](#paging-the-lists), and a page that has loaded is never dropped — not by a poll, not
  by a write.
- **Semantic invalidation:** a committed write refetches [exactly the reads it could have
  changed](#the-money-loop), never everything.
- **Rejections are data:** a "no" arrives on `lastOutcome` with its reason union intact; the
  promise does not reject. A route that answers something other than an envelope is transport,
  not a "no", and [that half does reject](#the-money-loop).
- **Browser-safe by construction:** hooks read, and the write door posts to _your_ route, so
  only a user token ever reaches a browser.
- **The store outlives the token:** `token` takes a function as readily as a string and is read
  once per request, on the hooks' reads and on `useSubmit`'s write alike. A session that
  refreshes keeps one store.
- **A dead session is one signal, not a storm:** a 401 [parks the store](#when-the-session-dies)
  — one `onUnauthorized`, every poll stopped, every loaded page kept — and `resume()` reads
  again once the host has a new bearer.

## Installation

```sh
npm i @pwngh/economy
```

`react` is a peer dependency. The runtime dependencies are three: `@pwngh/economy-client`,
`@pwngh/economy-core` — the one copy of the invalidation map — and `@pwngh/economy-lab`.

## Usage

```tsx
import { economyClient, EconomyProvider, useWallet } from '@pwngh/economy/ui';

let client = economyClient({ baseUrl: '/', token: () => session.token }); // a user token, only ever

function Balance() {
  let { data, error, refresh } = useWallet();
  if (error) return <p>wallet unavailable</p>;
  return <button onClick={refresh}>{data?.spendable ?? '…'}</button>; // 'CREDIT:400.00'
}

<EconomyProvider client={client}>
  <Balance />
</EconomyProvider>;
```

### The expansion table

| Hook                 | Client read              | Wire call               | Pages |
| -------------------- | ------------------------ | ----------------------- | ----- |
| `useWallet()`        | `client.wallet()`        | `GET /v1/wallet`        | no    |
| `useEntitlements()`  | `client.entitlements()`  | `GET /v1/entitlements`  | yes   |
| `useSubscriptions()` | `client.subscriptions()` | `GET /v1/subscriptions` | yes   |
| `usePayouts()`       | `client.payouts()`       | `GET /v1/payouts`       | yes   |

The bearer scopes every read: a user token reads only itself, so no hook takes a `userId`.
`loadMore()` does not widen this table. It is the same one client read asked for a wider
window, so one hook is still one wire path.

### Paging the lists

```tsx
import { economyClient, useEntitlements } from '@pwngh/economy/ui';

let client = economyClient({ baseUrl: '/', token: userToken, pageSize: 50 }); // 50 is default

let { data, loadMore, hasMore, loadingMore } = useEntitlements();

data.items.length; // 50 — the first page
data.cursor; // 'eyJrIjoiZW50aXRsZW1lbnRzIiwicyI6IndvcmxkLWtpdC0wNTAifQ' — the resume point
hasMore; // true — the wire handed back a cursor, so rows remain
await loadMore();
data.items.length; // 100 — the first fifty are still in there
loadingMore; // false — it is true only while a resuming read is out
```

The `/v1` lists answer `{ items, cursor }`, and `cursor` is a resume token: hand it back as
`?cursor=` and the next read starts at the row after the last one you were given. `loadMore()`
does exactly that and appends what comes back, which is why the rows you already had are still
there. The token is opaque — hold it, hand it back, never parse it.

`hasMore` is `data.cursor !== null`, which is the wire's own answer about whether more rows
exist rather than a guess from how full a read came back. One read still hands back at most
200 items — the exported `MAX_WINDOW`, where the route caps `?limit=` — but that is a cap per
read, not a ceiling on the list. A payout history of ten thousand rows pages all the way down.

The token is opaque, not signed, and it names a position and never a person. The server scopes
every read by the bearer, so presenting someone else's cursor on your own token reads your own
rows and nothing else.

`hasMore` and `loadingMore` sit on the store snapshot rather than in the hook's own
`useState`. `useSyncExternalStore` wants a `getSnapshot` that returns the same object until
something really changes, and one read key is one shared subscription — two components
calling `useEntitlements()` would otherwise disagree about whether a page was loading. So the
store owns the window exactly as it already owns `data` and `error`, and the hook adds only
the two stable callbacks.

### Polling and recovery

```tsx
let client = economyClient({ baseUrl: '/', token: userToken, pollMs: 15_000 }); // the default
```

A key polls while something is subscribed to it, and stops when the last subscriber leaves.
Polling needs a positive finite cadence: `false`, `0`, a negative and a non-finite value all
mean off. That matters because `setInterval` reads every one of those as "every millisecond" —
`pollMs: 0` is the natural spelling of "off" and used to be a continuous stream of
authenticated reads from every mounted component. A cadence longer than a timer can hold
(about 24.8 days) waits the longest it can rather than overflowing into the same loop.

A read that lands what the store already held tells nobody. The snapshot keeps its identity,
so `useSyncExternalStore` sees no change and nothing mounted re-renders — a poll over a wallet
that has not moved is one wire call and no render at all. A row that appeared, a balance that
moved, an error that reads differently: each of those is a new snapshot, and every consumer
hears it.

A read that fails puts its error beside the last good data and changes nothing else. There is
no automatic retry and no backoff. A failed read is read again on the next poll tick, on an
explicit `refresh()`, and on the next subscriber — an error is not a loaded state, so a
component that mounts over a key holding nothing but an error reads it. That is what makes a
remount the recovery from an expired token or a backend that was cold.

`close()` is teardown: it stops every timer and refuses every later read, `refresh()` and
`loadMore()` included, so no component still mounted can spend the old bearer.

### When the session dies

```tsx
let client = economyClient({
  baseUrl: '/',
  token: () => session.token,
  onUnauthorized: async () => {
    await session.signIn(); // your re-authentication, however it works
    client.resume();
  },
});
```

A 401 is the one failure a retry cannot fix, so it is the one the store treats differently: it
_parks_. Every poll timer stops, no new read starts, `onUnauthorized` fires **once** — not once
per key and not once per tick, so four keys polling do not become four sign-in prompts — and
every loaded page stays exactly where it was. The refusal rides beside the data as `error`, so
a component can say the session expired while still rendering the balance it already had.

`resume()` clears the park and re-reads every key that has subscribers, at the width it holds,
and restarts the polls. It is a fourth trigger beside subscribing, the poll tick and
`refresh()` — not a retry policy: the store still keeps no timer of its own and still never
backs off. A 401 after `resume()` parks again and asks again.

Minting the next bearer is yours. This package never holds a refresh token; it asks for a
bearer per request through `token` and tells you when the one it got was refused.

A re-authentication button lives inside the tree, so it reaches the store through a hook:

```tsx
import { useEconomyStore } from '@pwngh/economy/ui';

function SignInAgain() {
  let store = useEconomyStore();
  return <button onClick={() => store.resume()}>continue</button>;
}
```

`useEconomyStore()` hands back the same store `<EconomyProvider>` was given — the door to
`resume()`, `settled()` and `client` from a component that already sits under the provider.

Only a 401 parks. A 500, a timeout, a backend that is cold: those are read again on the next
poll tick, on `refresh()`, and on the next subscriber, exactly as above.

### Invalidation and a paged list

A committed write refetches `OUTCOME_READS[kind]` at the width each list currently holds. A
paged list is not reset to page one and it is not truncated: page four of a payout history
stays page four, and every row in it is re-read. That costs one call of up to 200 items, which
is the call `refresh()` already makes. Past 200 loaded rows one call cannot reach them all, so
the refetch re-reads the first 200 and leaves the rows below untouched — loaded, current as of
when they landed, and never dropped. The poll behaves identically, and a read that fails keeps
the loaded pages and puts the error beside them.

### The money loop

```tsx
import { useSubmit } from '@pwngh/economy/ui';

let { submit, pending, lastOutcome } = useSubmit('/checkout');

await submit({ sku: 'world-kit' }); // POSTs to YOUR route — its auth, its pricing
lastOutcome.status; // 'committed' | 'duplicate' | 'rejected'
```

The path joins `baseUrl` with exactly one slash between them, so the `baseUrl: '/'` above and
`useSubmit('/checkout')` post to `/checkout`. That matters because `//checkout` is a
protocol-relative URL: a browser reads `checkout` as the host and sends your bearer there.

On success exactly `OUTCOME_READS[kind]` refetches — a spend refreshes wallet and
entitlements; payouts and subscriptions stay quiet. A rejection refetches nothing, because
no money moved. A duplicate is a success replayed and invalidates the same set. A mapped read
refetches whether or not a hook is watching it: a balance the store already holds goes stale
after a purchase however it was read. A key nobody has read is left alone.

The kind comes from the envelope's `transaction.meta.kind`; a lifecycle marker's meta is
empty, so the sent draft's `kind` is the fallback, and with neither, every watched read
refreshes — a safe superset, never a stale miss.

`submit` resolves for every envelope the route answers, `'rejected'` included. It rejects when
the route answers something that is not an envelope — a 4xx, a 5xx, a gateway's HTML — with
`EconomyHttpError` carrying `status` and `body`, the same error the reads throw. A 5xx is
indeterminate and is never dressed up as a rejected outcome, because that would tell the
storefront the economy said no to a write that may have landed. So **await or catch**: a
`onClick={() => submit(body)}` that takes neither throws the reason away.

```tsx
<button onClick={() => void submit({ sku }).catch(report)}>buy</button>
```

### Waiting for the refetch

`submit` resolves on the route's answer, not on the reads that answer went stale. A buy button
is not held open by a refetch, and a refetch that is slow or fails does not take the write's
promise with it. When the order matters — write, re-read, then leave the page — the store's
`settled()` is the second step:

```tsx
let client = economyClient({ baseUrl: '/', token: userToken });

await submit({ sku: 'world-kit' }); // the route answered
await client.settled(); // and every read that answer went stale has landed
navigate('/library');
```

`settled()` sits on the store rather than the hook, and it answers for every read the store
has started: the refetches a write scheduled, a subscriber's first read, a poll tick already
out. It answers for the work outstanding when it was called — with polling on, a tick can
start another read the moment it resolves. Inside a component, `useEconomyStore()` is the
route to it.

### What it does not do

Optimistic UI, offline queueing, and websockets are non-goals until asked for. `useWallet()`
has no list and never grows one — a wallet is one object, not a page. No hook jumps to a page:
paging is forward only, one `loadMore()` at a time, and there is no page number to seek to. No
hook submits either: the write door is `useSubmit`, and it posts to your route. `pending` is per hook instance, concurrent submits on one instance run in order,
and the hooks are client-only — render them client-side.

## Related Packages

- [`@pwngh/economy-core`](../core) — the contract, including the invalidation map
- [`@pwngh/economy-client`](../client) — `newIdempotencyKey`, the key `useSubmit` defaults to
- [`@pwngh/economy-cli`](../cli) — `economy dev --demo` serves the reads these hooks call

## License

[MIT](../../LICENSE.md)
