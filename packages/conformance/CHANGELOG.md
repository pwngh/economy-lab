# Changelog

Notable changes to `@pwngh/economy-conformance`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `runStoreConformance`, `runCacheConformance`, `runRateLimiterConformance`,
  `runDispatcherConformance` and `runProcessorConformance` hold an implementation to its contract,
  each comparing it against a fresh in-memory oracle.
- `StoreConformanceOptions`, `RateLimiterHarness`, `DispatcherHarness` and `ProcessorHarness` are
  the shapes each suite takes.
- A declared capability the implementation does not carry fails the suite naming it; an undeclared
  one registers a skip naming what it needed.
- The suites were a subpath of `@pwngh/economy-lab` until 0.8.0. They are a package so the lab
  compiles only what it publishes: the suites reach the engine packages, and those import the lab.
