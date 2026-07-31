# Changelog

Notable changes to `@pwngh/economy-mysql`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `mysql(url, options?)` opens the pool, gates on the schema stamp, installs and proves the money routines, and returns a `Store`.
- `mysql({ pool })` and `mysqlStore({ pool })` build the same store over a caller-owned pool.
- `createMysqlPool`, `applyMysqlSchema`, and `readSchemaVersion` are the pool and migration verbs.
- `@pwngh/economy-mysql/mariadb` carries `createMariadbPool`, the pipelining wire behind the same seam.
- `db/mysql-schema.sql` ships in the tarball. The engine reads it from there.
