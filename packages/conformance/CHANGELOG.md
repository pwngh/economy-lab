# Changelog

Notable changes to `@pwngh/economy-conformance`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `runStoreConformance`, `runCacheConformance`, `runRateLimiterConformance`,
  `runDispatcherConformance` and `runProcessorConformance` run one port contract each.
  `runStoreConformance` also compares the store against a fresh in-memory oracle.
- `StoreConformanceOptions`, `RateLimiterHarness`, `DispatcherHarness` and `ProcessorHarness` are
  the shapes each suite takes.
- `runStoreConformance` takes a capability declaration. One the store does not carry fails the
  suite naming it; one left out skips its cases.
- The suites were the `./testing` subpath of `@pwngh/economy-lab` until 0.8.0.
