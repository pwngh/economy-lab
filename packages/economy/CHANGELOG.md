# Changelog

Notable changes to `@pwngh/economy`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- The umbrella: one door per sibling package export, and the `economy` bin. It holds no implementation of its own, and there is no root export.
- `manifest.json` is the door list. Key is the path a consumer types, value is the package export it re-exports.
- `scripts/generate.ts` rebuilds `src/` from the manifest wholesale, along with the export map, the dependency list, and the hoisted peers. `npm run generate` is the door.
- The generator validates every door before it writes anything, and stops the run with the offending door named.
- A door naming a package outside the workspace, a subpath the package does not export, or a peer range two packages disagree on is refused.
- Hoisted peers ride the umbrella and are marked optional: `react` for `economy/ui`, `mariadb` for `economy/mysql/mariadb`.
- `sideEffects` names the bin entry and nothing else, so a bundler drops every door a consumer does not import.
