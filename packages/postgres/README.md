# postgres

The PostgreSQL store for [`@pwngh/economy`](../economy). One call takes a connection URL and
hands back the `Store` the economy runs on, with the pool, the schema gate, the retries, and the
error translation already inside it.

## Features

- **One factory:** `postgres(url)` opens the pool, checks the schema stamp, installs the money
  routines and proves them, then returns the store. Nothing else to import.
- **Nothing to wire:** you never see a `pg.Pool`, a `connectionString`, a `SET search_path`, or a
  SQLSTATE. `close()` ends the pool it opened.
- **Contention handled in here:** a deadlock, a serialization failure, and a stale-head chain
  fork are all retried with widening jitter. A caller sees the commit, not the collision.
- **The schema ships with the package:** [`db/postgresql-schema.sql`](./db/postgresql-schema.sql)
  is the one file to apply, and the store refuses to open against a database that has drifted
  from it.
- **The same conformance suite as every other store:** it is run against a live Postgres in this
  package's own tests, not asserted in prose.

## Installation

```sh
npm i @pwngh/economy
```

`pg` comes with it. Nothing else is needed.

## Usage

```ts
import { postgres } from '@pwngh/economy/postgres';

export let ports = {
  store: await postgres(process.env.DATABASE_URL!, { poolMax: 32 }),
};
```

That is the whole integration. `poolMax` sizes the pool: each in-flight transaction holds one
connection for its entire life, so a service driving 32 concurrent submits wants at least 32.

### Applying the schema

The store never migrates. Apply the schema once, as an operator or in CI:

```sh
psql "$DATABASE_URL" -f db/postgresql-schema.sql
```

The file ships in the installed package, under its own `db/` directory.

Then open. A database at the wrong version fails at boot with the version it found and the
version the build wants — never mid-transaction, and never by silently migrating under you.

### Bringing your own pool

```ts
import { postgres } from '@pwngh/economy/postgres';

let store = await postgres({ pool: myOwnPool }); // same store, your wire
```

The pool needs no type parsers. Money is read through helpers that take `pg`'s default text and
`BigInt` alike, so a plain `new pg.Pool({ connectionString })` is enough — this package runs its
whole conformance suite a second time over one, to hold that. What a pool must not do is narrow
`int8` to a JS number: that rounds a balance past 2^53 before the engine ever sees it. `poolMax`
no longer applies — you sized it. Everything else is unchanged: the schema gate and money proof
still run.

Ownership follows creation. A pool you built stays yours: `store.close()` leaves it open, and
ending it is your call — so a store you built this way must not be the only thing your shutdown
awaits.

### A raw pool for your own tables

```ts
import { openPgPool } from '@pwngh/economy-postgres/driver';

let pool = await openPgPool({ connectionString: process.env.DATABASE_URL! });
await pool.query('select 1'); // { rows: [ { '?column?': 1 } ], rowCount: 1 }
```

This is for tooling that keeps its own tables beside the ledger. It is not part of the store
contract, and it is the only reason to reach past the front door.

### What this package does not do

- **It does not migrate.** No auto-create, no auto-upgrade, no `IF NOT EXISTS` at boot. A schema
  change is an operator action with a maintenance window.
- **It does not read `DATABASE_URL` for you.** The lab reports what the environment names, but
  the store arrives through `ports`, from this call. That is the whole point of the split.
- **It does not pool across processes.** One store, one pool. Put PgBouncer in front if you want
  shared pooling, in session mode — transaction mode breaks the advisory locks the engine takes.
- **It is not a read replica router.** Every read and write goes to the one connection string.

## Related Packages

- [`@pwngh/economy`](../economy) — the economy this store backs
- [`@pwngh/economy-mysql`](../mysql) — the same store contract over MySQL or MariaDB
- [`@pwngh/economy-redis`](../redis) — the read-through cache in front of it

## License

[MIT](../../LICENSE.md)
