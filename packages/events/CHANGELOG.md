# Changelog

Notable changes to `@pwngh/economy-events`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `EVENT_TYPES`: the fourteen types the economy emits, frozen, in the lab's order. `EVENT_VERSION` is 1.
- `KnownEvent` is the fourteen as one discriminated union, so a `switch` on `event.type` reads the right `data` in each branch.
- `EventDataMap` gives each type the `data` its emitter writes, read off the emit sites rather than declared alongside them.
- `narrowEvent(value)` takes parsed JSON to a `KnownEvent` or `null`, checking the envelope and the roster; the per-type `data` is the emitter's word.
- `isEvent(event, type)` narrows to one type, so a foreign object with a matching `type` is refused rather than narrowed.
- `isEventType` and `isEconomyEvent` are the roster and envelope checks on their own.
- Each type's `data` shape is exported by name, alongside `EventAmount` and `EventOf<T>`.
