# cli

The `economy` command. It runs your economy in development and production, and answers what
a module resolves to — five verbs, no more.

## Features

- **Runs the app:** `dev`, `serve`, and `worker` boot the same module through the same
  assembler an embedder calls — [the tooling never forks the contract](#the-same-assembler).
- **Answers what it is:** [`check`](#check) compiles the module and environment to one value
  and prints it with provenance; [`routes`](#routes) prints what actually mounts.
- **An exit-code contract:** `check` exits `2` on preflight errors, `1` on lints, `0` clean,
  so CI needs no output parsing.
- **Help that cannot drift:** [every page](#help-and-version) is rendered from the same flag
  table the parser reads, so it states exactly what the parser accepts.
- **A library, not just a binary:** `runEconomy(argv)` resolves an exit code, never calls
  `process.exit`, and [writes where you tell it](#the-same-assembler).

## Installation

```sh
npm i @pwngh/economy
```

The `economy` binary ships with [`@pwngh/economy`](../economy); this package is its
implementation and its library face.

## Usage

```sh
economy dev --demo          # in-memory, dev tokens, a seeded top-up → spend → rejection
economy serve               # production posture; refuses every dev stand-in before it binds
economy worker              # the worker-role process, no socket
economy check               # what this module and this environment resolve to
economy routes              # what it mounts
```

No file at all is a complete dev module — `dev`, `worker`, `check`, and `routes` run on
defaults. `serve` still refuses to listen without an auth posture.

### help and version

```sh
economy dev --help      # dev's usage, the flags it honors with their defaults, one example
economy check --help    # the same page for check
```

With no verb, `--help` prints the roster: one line per verb. `-h` is the same flag, `-v` the
same as `--version`, and both exit `0` — asking is not refusing. Each page is rendered from
the flag table `parse` reads, so a flag cannot appear in help without the parser honoring it.

The same table refuses a flag aimed at the wrong verb, naming where it belongs, so no run
ever accepts a flag it will not act on.

### check

```sh
economy check                 # the table: seams, posture, adapters, knobs, policy, preflight
economy check --json          # the same report, canonical, for tooling
economy check --desugar       # the module as the lab calls it compiles to
economy check --quiet-lints   # lints stop being an exit-1
```

The compile is pure — it opens nothing and dials nothing — so `check` is safe in a build
step with no database in reach.

### routes

```sh
economy routes         # auth posture, the mounted table, providers, worker job count
economy routes --json  # each route tagged `module` (yours) or `product` (ours)
```

A module that states no auth posture has no network face, and the table says so rather
than listing routes that would never answer.

### The same assembler

```ts
import { runEconomy } from '@pwngh/economy/cli';

let exitCode = await runEconomy(['check', '--json']); // 0 | 1 | 2
```

`dev`, `serve`, and `worker` resolve only when the process is shutting down, so the caller
that awaits them owns the exit.

Every verb writes through the streams you hand it — banners, reports, and refusals alike —
so a host reads the output instead of racing the console for it.

```ts
let held = '';
let code = await runEconomy(['routes'], {
  stdout: {
    write: (text) => {
      held += text;
    },
  },
}); // 0
```

## Related Packages

- [`@pwngh/economy-core`](../core) — the module contract and `createApp` these verbs load
- [`@pwngh/economy`](../economy) — the umbrella that ships this binary as the `economy` command
- [`@pwngh/economy-test`](../test) — the deterministic harness these verbs boot in tests
- [`@pwngh/economy-adapters`](../adapters) — mount the same handler on your own framework

## License

[MIT](../../LICENSE.md)
