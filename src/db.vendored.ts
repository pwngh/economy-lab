/**
 * @pwngh/money
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

/**
 * The database carrier, as the /db subpath the importer composes in. A host that
 * keeps its own database — managed Postgres, a MySQL cluster, anything this file
 * has a dialect for — never gets trusted to conform; it gets asked. `install*`
 * applies the idempotent DDL (shipped as string constants, the schema-as-string
 * rule, so nothing here can drift from a file), and `prove*` re-runs the
 * conformance vectors against the live engine and returns the failures, empty when
 * the database demonstrably implements the semantics. Assert empty at boot, the
 * way consumers assert `selfTest()` on a vendored file.
 *
 * Zero imports, like every sibling: the caller passes `vectors` from the main
 * entry, and the database driver enters structurally as `SqlRunner` — a pg pool,
 * a mysql2 connection, or a test fake all adapt in one line:
 *
 *   pg:     { run: (sql, p) => pool.query(sql, p as unknown[]).then((r) => r.rows) }
 *   mysql2: { run: (sql, p) => conn.query(sql, p as unknown[]).then(([rows]) => rows) }
 *
 * Only the div, muldiv, and bps vector families run here — divRound and splitBps
 * are the reconciliation semantics a database re-derives; parsing and the wire
 * codec stay application-side. Results cross the wire as strings so no driver's
 * number handling can corrupt an i64.
 */

/** Bumped on any breaking change to the DDL below; prove* fails on a mismatch. */
export const DB_VERSION = 1;

/** The minimal slice of a database driver this file needs. Rows come back as objects. */
export interface SqlRunner {
  run(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

/** One conformance vector, structurally — pass `vectors` from '@pwngh/money'. */
export type Vector = readonly unknown[];

/**
 * PostgreSQL DDL: schema `money`, `div_round` and `split_bps` on exact numeric
 * div()/mod() (truncation toward zero, matching BigInt), the psql-side vectors
 * table with `conformance()` and `prove()`, and the version stamp. Idempotent;
 * apply with installPostgres or psql. `scripts/emit.ts` projects this constant to
 * `out/money.sql` for psql-only consumers; nothing imports the projection back.
 */
export const moneySql = `
create schema if not exists money;

create table if not exists money.meta (
  version integer not null
);

delete from money.meta where version <> ${DB_VERSION};
insert into money.meta (version)
  select ${DB_VERSION} where not exists (select 1 from money.meta);

-- Integer division with the rounding mode named at the call site, the divRound
-- carrier. q and r come from div()/mod(), which truncate toward zero exactly like
-- BigInt; the mode adjustments and the i64 range check mirror src/money.ts line
-- for line, including the quirk that an unknown mode with a zero remainder
-- returns rather than raises.
create or replace function money.div_round(num numeric, den numeric, mode text)
returns bigint
language plpgsql immutable
as $fn$
declare
  q numeric;
  r numeric;
  negative boolean;
  twice numeric;
  magnitude numeric;
  step numeric;
begin
  if den = 0 then
    raise exception 'div_round: zero divisor';
  end if;
  q := div(num, den);
  r := mod(num, den);
  if r <> 0 then
    negative := (num < 0) <> (den < 0);
    if mode = 'trunc' then
      null;
    elsif mode = 'floor' then
      if negative then q := q - 1; end if;
    elsif mode = 'ceil' then
      if not negative then q := q + 1; end if;
    elsif mode = 'halfEven' or mode = 'halfUp' then
      twice := 2 * abs(r);
      magnitude := abs(den);
      step := case when negative then -1 else 1 end;
      if twice > magnitude then
        q := q + step;
      elsif twice = magnitude then
        if mode = 'halfUp' or mod(q, 2) <> 0 then q := q + step; end if;
      end if;
    else
      raise exception 'div_round: unknown mode %', mode;
    end if;
  end if;
  if q < -9223372036854775808 or q > 9223372036854775807 then
    raise exception 'i64 overflow';
  end if;
  return q;
end
$fn$;

-- Basis-point split, floor per share, remainder to the caller: the splitBps
-- carrier. minor * b is computed in numeric so a near-I64_MAX minor cannot
-- overflow the intermediate; div() truncation toward zero reproduces the pinned
-- negative-split behavior (toward-zero shares, negative remainder).
create or replace function money.split_bps(
  minor bigint,
  bps integer[],
  out shares bigint[],
  out remainder bigint
)
language plpgsql immutable
as $fn$
declare
  total integer := 0;
  b integer;
  share numeric;
  used numeric := 0;
begin
  shares := array[]::bigint[];
  foreach b in array bps loop
    if b < 0 then raise exception 'split_bps: bad bps'; end if;
    total := total + b;
  end loop;
  if total > 10000 then
    raise exception 'split_bps: bps exceed 10000';
  end if;
  foreach b in array bps loop
    share := div(minor::numeric * b, 10000);
    used := used + share;
    shares := shares || share::bigint;
  end loop;
  remainder := (minor::numeric - used)::bigint;
end
$fn$;

-- One row per conformance vector, for the pure-psql path (db/prove.sql loads it).
create table if not exists money.vectors (
  v jsonb not null
);

-- Runs every div, muldiv, and bps vector and returns one text row per failure;
-- empty means conformant. 'throws' vectors must raise; anything else must match
-- byte for byte, and bps rows must also conserve.
create or replace function money.conformance()
returns setof text
language plpgsql
as $fn$
declare
  vec jsonb;
  kind text;
  want text;
  got text;
  got_shares bigint[];
  got_remainder bigint;
  want_shares bigint[];
  in_bps integer[];
  minor bigint;
begin
  for vec in select v from money.vectors where v->>0 in ('div', 'muldiv', 'bps') loop
    kind := vec->>0;
    if kind = 'div' or kind = 'muldiv' then
      want := case when kind = 'div' then vec->>4 else vec->>5 end;
      begin
        if kind = 'div' then
          got := money.div_round((vec->>1)::numeric, (vec->>2)::numeric, vec->>3)::text;
        else
          got := money.div_round(
            (vec->>1)::numeric * (vec->>2)::numeric, (vec->>3)::numeric, vec->>4)::text;
        end if;
        if want = 'throws' then
          return next format('%s got %s, wanted raise', vec::text, got);
        elsif got <> want then
          return next format('%s got %s', vec::text, got);
        end if;
      exception when others then
        if want <> 'throws' then
          return next format('%s raised: %s', vec::text, sqlerrm);
        end if;
      end;
    else
      begin
        minor := (vec->>1)::bigint;
        select coalesce(array_agg(x.val::integer order by x.ord), array[]::integer[])
          into in_bps
          from jsonb_array_elements_text(vec->2) with ordinality as x(val, ord);
        select coalesce(array_agg(x.val::bigint order by x.ord), array[]::bigint[])
          into want_shares
          from jsonb_array_elements_text(vec->3) with ordinality as x(val, ord);
        select p.shares, p.remainder into got_shares, got_remainder
          from money.split_bps(minor, in_bps) p;
        if got_shares <> want_shares or got_remainder <> (vec->>4)::bigint then
          return next format('%s got %s r %s', vec::text, got_shares, got_remainder);
        elsif coalesce((select sum(s) from unnest(got_shares) s), 0) + got_remainder
              <> minor then
          return next format('%s does not conserve', vec::text);
        end if;
      exception when others then
        return next format('%s raised: %s', vec::text, sqlerrm);
      end;
    end if;
  end loop;
end
$fn$;

-- The assertion psql runs: raises unless vectors are loaded and every one passes,
-- so \`psql -c 'select money.prove()'\` is a red/green exit code.
create or replace function money.prove()
returns void
language plpgsql
as $fn$
declare
  failure text;
  failures integer := 0;
  loaded integer;
begin
  select count(*) into loaded
    from money.vectors where v->>0 in ('div', 'muldiv', 'bps');
  if loaded = 0 then
    raise exception 'money.prove: no vectors loaded';
  end if;
  for failure in select money.conformance() loop
    raise warning '%', failure;
    failures := failures + 1;
  end loop;
  if failures > 0 then
    raise exception 'money.prove: % of % vectors failed', failures, loaded;
  end if;
  raise notice 'money.prove: % vectors conformant', loaded;
end
$fn$;
`;

/**
 * MySQL DDL as one statement per element, because a driver must send each
 * separately (DELIMITER is a CLI-client construct, not server syntax; a function
 * body's inner semicolons are fine within a single statement). Same semantics as
 * the Postgres pair: DECIMAL(40,0) intermediates (the muldiv vectors overflow
 * BIGINT by design), DIV/MOD truncation toward zero matching BigInt, i64 range
 * enforced with SIGNAL. split_bps returns JSON with shares and remainder as
 * strings so an i64 never rides a JSON number. Apply with installMysql;
 * `scripts/emit.ts` projects a DELIMITER-wrapped `out/money.mysql.sql` for the
 * mysql CLI.
 */
export const moneyMysql: readonly string[] = [
  `create table if not exists money_meta (
  version integer not null
)`,
  `delete from money_meta where version <> ${DB_VERSION}`,
  `insert into money_meta (version)
  select ${DB_VERSION} from dual where not exists (select 1 from money_meta)`,
  `drop function if exists money_div_round`,
  `create function money_div_round(num decimal(40, 0), den decimal(40, 0), mode varchar(16))
returns bigint deterministic
begin
  declare q decimal(40, 0);
  declare r decimal(40, 0);
  declare negative bool;
  declare twice decimal(40, 0);
  declare magnitude decimal(40, 0);
  declare step int;
  if den = 0 then
    signal sqlstate '45000' set message_text = 'div_round: zero divisor';
  end if;
  set q = num div den;
  set r = num - q * den;
  if r <> 0 then
    set negative = (num < 0) <> (den < 0);
    if mode = 'floor' then
      if negative then set q = q - 1; end if;
    elseif mode = 'ceil' then
      if not negative then set q = q + 1; end if;
    elseif mode = 'halfEven' or mode = 'halfUp' then
      set twice = 2 * abs(r);
      set magnitude = abs(den);
      set step = if(negative, -1, 1);
      if twice > magnitude then
        set q = q + step;
      elseif twice = magnitude then
        if mode = 'halfUp' or q % 2 <> 0 then set q = q + step; end if;
      end if;
    elseif mode <> 'trunc' then
      signal sqlstate '45000' set message_text = 'div_round: unknown mode';
    end if;
  end if;
  if q < -9223372036854775808 or q > 9223372036854775807 then
    signal sqlstate '45000' set message_text = 'i64 overflow';
  end if;
  return q;
end`,
  `drop function if exists money_split_bps`,
  `create function money_split_bps(minor bigint, bps json)
returns json deterministic
begin
  declare total int default 0;
  declare i int default 0;
  declare n int;
  declare b int;
  declare share decimal(40, 0);
  declare used decimal(40, 0) default 0;
  declare shares json default json_array();
  set n = json_length(bps);
  while i < n do
    set b = json_extract(bps, concat('$[', i, ']'));
    if b < 0 then
      signal sqlstate '45000' set message_text = 'split_bps: bad bps';
    end if;
    set total = total + b;
    set i = i + 1;
  end while;
  if total > 10000 then
    signal sqlstate '45000' set message_text = 'split_bps: bps exceed 10000';
  end if;
  set i = 0;
  while i < n do
    set b = json_extract(bps, concat('$[', i, ']'));
    set share = cast(minor as decimal(40, 0)) * b div 10000;
    set used = used + share;
    set shares = json_array_append(shares, '$', cast(share as char));
    set i = i + 1;
  end while;
  return json_object('shares', shares, 'remainder', cast(minor - used as char));
end`,
];

/** Applies the Postgres DDL. Idempotent; safe to run at every boot. */
export async function installPostgres(db: SqlRunner): Promise<void> {
  await db.run(moneySql);
}

/** Applies the MySQL DDL. Idempotent; safe to run at every boot. */
export async function installMysql(db: SqlRunner): Promise<void> {
  for (const statement of moneyMysql) {
    await db.run(statement);
  }
}

// One engine's callable surface: how to fetch the stamp, divide, and split. The
// prove loop below is engine-blind; these three queries are the whole dialect.
interface Engine {
  version(db: SqlRunner): Promise<string>;
  div(db: SqlRunner, num: string, den: string, mode: string): Promise<string>;
  bps(
    db: SqlRunner,
    minor: string,
    bps: string,
  ): Promise<{ shares: string[]; remainder: string }>;
}

const postgres: Engine = {
  async version(db) {
    const rows = await db.run('select version from money.meta');
    return String(rows[0]?.['version']);
  },
  async div(db, num, den, mode) {
    const rows = await db.run(
      'select money.div_round($1::numeric, $2::numeric, $3)::text as r',
      [num, den, mode],
    );
    return String(rows[0]?.['r']);
  },
  async bps(db, minor, bps) {
    const rows = await db.run(
      `select array_to_json(p.shares::text[])::text as shares, p.remainder::text as remainder
       from money.split_bps(
         $1::bigint,
         (select coalesce(array_agg(x.val::integer order by x.ord), array[]::integer[])
          from jsonb_array_elements_text($2::jsonb) with ordinality as x(val, ord))) as p`,
      [minor, bps],
    );
    return {
      shares: JSON.parse(String(rows[0]?.['shares'])) as string[],
      remainder: String(rows[0]?.['remainder']),
    };
  },
};

const mysql: Engine = {
  async version(db) {
    const rows = await db.run('select version from money_meta');
    return String(rows[0]?.['version']);
  },
  async div(db, num, den, mode) {
    const rows = await db.run('select cast(money_div_round(?, ?, ?) as char) as r', [
      num,
      den,
      mode,
    ]);
    return String(rows[0]?.['r']);
  },
  async bps(db, minor, bps) {
    const rows = await db.run('select cast(money_split_bps(?, cast(? as json)) as char) as r', [
      minor,
      bps,
    ]);
    const parsed = JSON.parse(String(rows[0]?.['r'])) as {
      shares: string[];
      remainder: string;
    };
    return parsed;
  },
};

// Runs the div, muldiv, and bps vector families against a live engine and returns
// the failures. muldiv products are computed here in bigint (exactly) so the
// database's div_round sees the same oversized intermediate the vectors pin.
async function prove(
  db: SqlRunner,
  engine: Engine,
  vectors: readonly Vector[],
): Promise<string[]> {
  const failures: string[] = [];
  const version = await engine.version(db).catch((error: unknown) => `unreadable: ${error}`);
  if (version !== String(DB_VERSION)) {
    failures.push(`meta version ${version}, package expects ${DB_VERSION}`);
    return failures;
  }
  let ran = 0;
  for (const v of vectors) {
    const kind = v[0];
    if (kind === 'div' || kind === 'muldiv') {
      const [num, den, mode, want] =
        kind === 'div'
          ? [String(v[1]), String(v[2]), String(v[3]), String(v[4])]
          : [
              (BigInt(String(v[1])) * BigInt(String(v[2]))).toString(),
              String(v[3]),
              String(v[4]),
              String(v[5]),
            ];
      ran += 1;
      try {
        const got = await engine.div(db, num, den, mode);
        if (want === 'throws') failures.push(`${JSON.stringify(v)} got ${got}, wanted raise`);
        else if (got !== want) failures.push(`${JSON.stringify(v)} got ${got}`);
      } catch (error) {
        if (want !== 'throws') failures.push(`${JSON.stringify(v)} raised: ${error}`);
      }
    } else if (kind === 'bps') {
      ran += 1;
      try {
        const got = await engine.bps(db, String(v[1]), JSON.stringify(v[2]));
        const want = (v[3] as readonly string[]).map(String);
        const conserves =
          got.shares.reduce((sum, s) => sum + BigInt(s), 0n) + BigInt(got.remainder) ===
          BigInt(String(v[1]));
        if (
          got.shares.length !== want.length ||
          got.shares.some((s, i) => s !== want[i]) ||
          got.remainder !== String(v[4])
        ) {
          failures.push(`${JSON.stringify(v)} got ${got.shares} r ${got.remainder}`);
        } else if (!conserves) {
          failures.push(`${JSON.stringify(v)} does not conserve`);
        }
      } catch (error) {
        failures.push(`${JSON.stringify(v)} raised: ${error}`);
      }
    }
  }
  if (ran === 0) failures.push('no div, muldiv, or bps vectors supplied');
  return failures;
}

/**
 * Proves a live Postgres implements the semantics: returns failures, empty when
 * conformant. Assert empty at boot.
 */
export function provePostgres(db: SqlRunner, vectors: readonly Vector[]): Promise<string[]> {
  return prove(db, postgres, vectors);
}

/**
 * Proves a live MySQL implements the semantics: returns failures, empty when
 * conformant. Assert empty at boot.
 */
export function proveMysql(db: SqlRunner, vectors: readonly Vector[]): Promise<string[]> {
  return prove(db, mysql, vectors);
}
