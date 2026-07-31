# Changelog

Notable changes to `@pwngh/economy-money`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `Money`, `Rate`, and `Bps`: the value faces over an amount, a conversion rate, and a basis-point share. Each parses a wire string, an init object, or the lab's own type.
- `createMoney`, `createRate`, and `createBps` are the factories beside them; `bps(count)` builds one from a bare basis-point count.
- `Bps.fee` is the platform fee on a price, rounded up to a whole credit and capped at the price; `Bps.revenue` is the fee plus the rounding residual.
- `Bps.fee` and `Bps.revenue` refuse a price that is not CREDIT. `Bps.share` takes any currency.
- `Bps.assertShareSum` requires shares to sum to `Bps.WHOLE`, 10,000, and refuses a share of zero. An empty list passes: the whole net goes to platform revenue.
- A basis-point count outside 0 to 10,000, a share spelled anything but `bps`, and `Rate.from(null)` are each refused.
- `RateInit` requires `rate`, `scale`, and `rateId`; a rate missing any of the three is refused with `CONFIG.INVALID` rather than read at a default.
- `credits` and `usd` re-export verbatim from the ledger, reached through `economy/money`.
- Arithmetic is the ledger's. This package owns types, parsing, serialization, and validation messages, and delegates every computation to `@pwngh/economy-lab`.
