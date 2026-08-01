# Changelog

Notable changes to `@pwngh/economy-cli`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- The `economy` command, reached through `economy/cli`. It ships no bin of its own — `@pwngh/economy` carries the entry and is the only place that exits.
- The verbs are `dev`, `serve`, `worker`, `check`, and `routes`. A missing verb refuses with usage and exit `2`, the same as an unknown one.
- `runEconomy(argv, options?)` resolves an exit code and never calls `process.exit`, so a host can drive the CLI in-process.
- `options` is `{ stdout?, stderr? }`, each a `Sink` — one `write(text)` method. No source file calls the console.
- The exit codes: `0` clean, `1` for a refusal or a lint, `2` for a parse refusal and for a preflight error under `check`.
- `economy check` prints what the module and environment resolve to, with each knob's provenance; `--json` and `--desugar` print the same report other ways.
- `check --json --desugar` carries the floor calls in the JSON report as a `desugar` field.
- `economy routes` prints the auth posture and one `METHOD path` line per route that answers.
- `economy serve` binds through its own runtime bridge: `node:http` on Node, `Bun.serve` on Bun, `Deno.serve` on Deno. Every bridge drops an inbound client-address header and stamps the peer itself.
- `economy serve` refuses unless `NODE_ENV` is `production`, and `economy dev` refuses when it is.
- `economy dev` watches the module file with a 120 ms debounce, loads `.env` through `node --env-file`, and prints a banner with three working curls.
- Every verb runs under the `.env` beside the module — `dev` through `node --env-file`, the other four adopted before the load; a name already set in the environment wins.
- The directory form: `economy/app.ts` is the root module and `economy/routes/**` are the URL-addressed files — filename is the path, export name is the role.
- `routes/index.*` addresses its containing path: `routes/index.ts` mounts `/` and `routes/shop/index.ts` mounts `/shop`.
- A webhook `decode` export that is not a function refuses `SEAM_SHAPE`, the same code a misshapen route export raises.
- A module file that plain node cannot parse re-execs once with `--experimental-strip-types`, so a TypeScript module runs on node 22 with no loader.
- A flag aimed at a verb that does not act on it refuses with exit `2`, naming the verbs that do take it.
- A value flag given twice refuses with exit `2`, naming both values.
