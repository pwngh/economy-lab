# Changelog

Notable changes to `@pwngh/economy-ui`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `economyClient(options)` wraps the lab wire client with per-key polling and invalidate-on-write.
- `<EconomyProvider>` plus `useWallet`, `useEntitlements`, `useSubscriptions`, and `usePayouts`; each hook compiles to one client read.
- `useWallet` returns `{ data, error, refresh }`, and the three list hooks add `loadMore`, `hasMore`, and `loadingMore`.
- `useSubmit(path)` posts a body to a host route and refetches the reads that outcome touches; a rejection refetches nothing.
- `pollMs` defaults to 15,000 and polls only on a positive finite cadence; `false`, `0`, a negative and a non-finite value all disable it, and a cadence past the timer ceiling waits 2,147,483,647 ms.
- `pageSize` defaults to 50, and the route's ceiling is 200 items.
- `token` takes a function as well as a string, read fresh on every request, so a store outlives the bearer it was built with.
- A failed read keeps the last good data and carries the error beside it.
- A read that lands what the snapshot already held keeps that snapshot object and notifies nobody.
- `settled()` resolves once every read the store has started has landed, the refetches a committed write scheduled included.
- A key holding no data is read again by the next subscriber; a failed read recovers on a remount, on a poll tick, and on `refresh()`.
- `close()` refuses every later read, `refresh()` and `loadMore()` included.
- A read joins the read already in flight only when it asks for the same window and resume point; anything else queues behind it.
- A list holds each row once, so a refresh that cannot re-read every loaded row never lands one twice.
- `loadingMore` clears on every path out of `loadMore()`, including the ones that decide not to read.
- A committed write refetches every mapped read the store has already read, subscribed or not.
- `submitRoute` throws `EconomyHttpError` with the status and body when a route answers something other than an envelope.
- `submitRoute` joins `baseUrl` and the route path with exactly one slash between them.
- `onUnauthorized(error)` fires once when a read or a write answers 401 and the store parks: every poll timer stops, no new read starts, and every loaded page stays. Only 401 parks.
- `resume()` clears the park, restarts the polls, and re-reads every key that has subscribers at the width it holds.
- `useEconomyStore()` returns the store `<EconomyProvider>` was given, which is how a component reaches `resume()`, `settled()` and `client`.
- A hook called outside a provider throws, naming the hook that called it.
- `@pwngh/economy-ui/core` ships the core without the React import.
