# mysql

The MySQL store for [`@pwngh/economy`](../economy). One call takes a connection URL and hands
back the `Store` the economy runs on, with the pool, the schema gate, the deadlock retries, and
the error translation already inside it. MariaDB rides the same store on a faster wire.

## Features

- **One factory:** `mysql(url)` opens the pool, checks the schema stamp, installs the money
  routines and proves them, then returns the store. Nothing else to import, and `close()` ends
  the pool it opened.
- **The InnoDB contention problems, designed out:** READ COMMITTED per connection, a single
  atomic `INSERT IGNORE` for every idempotency claim, and locking reads in one global account
  order. Gap-lock deadlocks are removed rather than retried.
- **What is left gets retried:** deadlock, lock-wait timeout, named-lock deadlock, and stale-head
  chain forks, with widening jitter. A caller sees the commit, not the collision.
- **MariaDB as a one-line swap:** the pipelining `mariadb` pool fills the same seam. Same store,
  same schema, same SQL, different wire.
- **The schema ships with the package:** [`db/mysql-schema.sql`](./db/mysql-schema.sql) is the one
  file to apply, and the store refuses a database that has drifted from it.

## Installation

```sh
npm i @pwngh/economy
```

`mysql2` comes with it. `mariadb` is an optional peer, and only for the swap below.

## Usage

```ts
import { mysql } from '@pwngh/economy/mysql';

export let ports = {
  store: await mysql(process.env.DATABASE_URL!, { poolMax: 32 }),
};
```

That is the whole integration. `poolMax` sizes the pool: each in-flight transaction holds one
connection for its entire life, so a service driving 32 concurrent submits wants at least 32.

### Applying the schema

The store never migrates. Apply the schema once, as an operator or in CI:

```sh
mysql "$DATABASE" < db/mysql-schema.sql
```

The file ships in the installed package, under its own `db/` directory. It drops and recreates
the tables, so it resets rather than upgrades. A database at the wrong version fails at boot
with the version it found and the version the build wants.

### MariaDB on the same store

```ts
import { mysql } from '@pwngh/economy/mysql';
import { createMariadbPool } from '@pwngh/economy/mysql/mariadb';

let pool = await createMariadbPool(process.env.DATABASE_URL!, {
  connectionLimit: 32,
});
let store = await mysql({ pool }); // same store, pipelined wire
```

Every statement above the pool seam is identical. Only the driver differs.

### Bringing your own pool

Ownership follows creation. A pool you built — the `mariadb` one above, a `createMysqlPool`
pool, or anything filling the seam — stays yours: `store.close()` leaves it open, and ending it
is your call. Only the pool `mysql(url)` opened for you is ended by `close()`.

### What this package does not do

- **It does not migrate.** No auto-create, no auto-upgrade at boot. `applyMysqlSchema` drops and
  recreates; it is a setup and CI verb, never an application one.
- **It does not read `DATABASE_URL` for you.** The lab reports what the environment names, but
  the store arrives through `ports`, from this call.
- **Requires MySQL 8.0.17 or newer.** The schema uses `JSON_TABLE` and the `utf8mb4_0900_bin`
  collation to keep identifiers case-sensitive. Tests use MySQL 8.4 with both supported drivers.
- **It does not accept `REPEATABLE READ`.** The store sets `READ COMMITTED` on every connection
  it borrows. A server default that is enforced against change is not supported.

## Related Packages

- [`@pwngh/economy`](../economy) — the economy this store backs
- [`@pwngh/economy-postgres`](../postgres) — the same store contract over PostgreSQL
- [`@pwngh/economy-redis`](../redis) — the read-through cache in front of it

## License

[MIT](../../LICENSE.md)
