# create-economy

Create a new Economy app in a new directory. One command writes a project that depends on
`@pwngh/economy` and nothing else.

## Features

- **The project runs before you edit it** - what it writes passes `economy check`, builds, serves, and has a green test suite the moment it lands
- **One dependency in what it writes** - a scaffolded project depends on `@pwngh/economy` and imports the flat doors, never the individual packages
- **Two templates** - the repository suite walks every combination this offers end to end, so an option that does not run cannot ship
- **The choices are one table** - the prompt, the flags, and the walk gate all read the same roster and cannot disagree about what exists
- **No terminal needed** - `--yes` plus flags scaffolds unprompted, so continuous integration drives it

## Installation

Nothing to install. `npm create` fetches it, runs it once, and is done:

```sh
npm create @pwngh/economy@latest my-shop
```

`npx create-economy my-shop` is the same command spelled the other way.

## Usage

Run it with no arguments and it asks for a directory and a template:

```sh
npm create @pwngh/economy@latest
# directory (my-economy) my-shop
# template [starter|marketplace] (starter) marketplace
```

Answer on the command line instead, and it asks nothing:

```sh
npm create @pwngh/economy@latest my-shop -- --template marketplace --yes
```

Then the scaffolded project takes over:

```sh
cd my-shop
npm install
npm run check   # the module and the environment compiled to one truth pass
npm run dev     # http://127.0.0.1:3000, memory store, dev tokens
npm test        # the same arc on deterministic ports, no socket
```

### The templates

| Template      | What it starts you with                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `starter`     | A first-party storefront: a listings map, a top-up menu, a bearer posture, and a checkout route that prices itself from the catalog |
| `marketplace` | The seller arc on top of that: fee splits across recipients, a provider webhook decoder, a payout route, and post-commit handlers   |

Both write the same shape — one `economy.app.ts` of named exports, a `tsconfig.json`, a test that walks the arc, and a README. The marketplace is the larger app, not the finished one.

`--list` prints the roster without writing anything:

```sh
create-economy --list
# template:
#   starter      the smallest module that boots: a catalog, a posture, a checkout route
#   marketplace  the seller arc: fee splits, a provider webhook, payouts, an after handler
```

### What a scaffolded project looks like

```
my-shop/
  economy.app.ts     the whole app: named exports, everything optional except the posture
  test/economy.test.ts
  tsconfig.json
  package.json       one dependency: @pwngh/economy
  Dockerfile         builds the production image
  .dockerignore
  .env.example       every value `economy serve` demands in production
  .gitignore
  README.md
```

The app file is the product. Prices come from your own listings, never from frozen config:

```ts
import { credits } from '@pwngh/economy/money';

let listings = new Map([
  [
    'world-kit',
    {
      price: credits(25_000),
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    },
  ],
]);

listings.get('world-kit')?.price; // credits(25_000), about $208 at 120 credits to the dollar
```

### Flags

| Flag                  | What it does                                                             |
| --------------------- | ------------------------------------------------------------------------ |
| `--template name`     | `starter` or `marketplace`; unset asks, or takes `starter` under `--yes` |
| `--yes`               | Take every default and ask nothing                                       |
| `--force`             | Write into a directory that already holds files                          |
| `--list`              | Print the choices and leave                                              |
| `--help`, `--version` | Answer and leave                                                         |

A directory that already holds files is refused by default, and nothing is written before that check passes — a refused run leaves the directory exactly as it found it.

### What this does NOT do

- **No install.** It writes files and stops. `npm install` is yours to run, so the scaffolder has zero dependencies and no network step
- **No git init.** No repository is created and no commit is made
- **No database setup.** Templates run on a memory store; migrations and a real `DATABASE_URL` are yours
- **No deploy target.** There is no Next.js or Cloudflare template, because the `economy` command has five verbs and every one of them runs or explains a single module file — a template it cannot drive is one the walk gate cannot prove. Docker needs no template of its own: both templates ship a `Dockerfile` that builds the production image
- **No update path.** It scaffolds once; it never migrates an existing project

## Related Packages

- [`@pwngh/economy`](https://github.com/pwngh/economy-lab/tree/main/packages/economy) - The one dependency every template installs, and the `economy` command they run
- [`@pwngh/economy-lab`](https://github.com/pwngh/economy-lab) - The ledger underneath the doors, one line away when a project needs it

## License

[MIT](./LICENSE)
