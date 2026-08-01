# Changelog

Notable changes to `create-economy`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `create-economy [directory]` writes a working project and stops. It runs no install, creates no repository, and touches no network.
- Two templates: `starter` is a first-party storefront, and `marketplace` adds recipient fee splits, a provider webhook decoder, a payout route, and post-commit handlers.
- Both templates depend on `@pwngh/economy` alone and import the flat doors.
- Each ships an `economy.app.ts`, a test that walks its arc through `openTestEconomy`, a tsconfig that emits to `dist`, a two-stage Dockerfile, a README, and the dotfiles a project needs.
- The option table in `src/lib/options.ts` is the one roster: the prompt, the flags with their short forms, and the repository's walk gate all read it.
- Without `--yes` and without a full command line, the questions are asked on a terminal; with no terminal to ask, the run refuses instead of guessing.
- A directory that already holds files is refused, and nothing is written before that check.
- Template dotfiles are stored with a leading underscore and renamed on the way out, because npm drops a file named `.gitignore` from the tarball it publishes.
- The package is a bin and nothing else: it exports no module surface, and it declares no runtime dependency.
