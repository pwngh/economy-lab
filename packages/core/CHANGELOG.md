# Changelog

Notable changes to `@pwngh/economy-core`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `createApp(module, options)` builds a running economy from an `economy.app.ts` module. It constructs everything and starts nothing.
- `listen()` binds and then starts the background half; `startWorker()` is the worker-role process. `close()` is ordered and idempotent.
- `App.handler` and `listen()` refuse without an `authenticate` posture (`AUTH_POSTURE`); in-process use of the economy needs none.
- `withDev(definition, env?)` applies the dev posture. Applying it twice changes nothing.
- `compileEconomy(definition, env, flags?)` resolves a module and an environment to one `EconomyTruth`, pure over its inputs.
- The root is two values, `createApp` and `withDev`. The exports are `.`, `./module`, `./ops`, `./internal`, and `./package.json`.
- `@pwngh/economy-core/module` is the contract subpath: the seam types, the resolver, the compile, and `EconomyModuleError`.
- The seams a module states, ten in all: `policy`, `catalog`, `authenticate`, `providers`, `worker`, `ports`, `instances`, `flags`, `after`, and `routes`.
- A `ports` name outside the fifteen-slot roster refuses with `SEAM_SHAPE`, and a flag outside `payouts`, `supervisor` and `reads` refuses with `NOT_YET`. The retired `ops` flag refuses by naming `supervisor` as its replacement.
- A route handler returns a `Response` or an `OperationDraft`, submitted through the one write door and keyed from the caller's `idempotency-key` header.
- A route draft naming a server-set field is refused with a `400` that names the field, the way the lab's own door refuses a request body naming it. `OperationDraft` excludes those fields too, derived from the lab's wire table.
- Knobs resolve with provenance — definition > flag > env > default — and read under the lab's integer rule, so `WORKER_BATCH=0` takes the documented default.
- Every reply echoes a correlation id.
