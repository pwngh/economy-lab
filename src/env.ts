/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

/**
 * The single environment module: every entry point reads the environment once at its edge and
 * parses it through these functions, so one rule governs the whole lab.
 *
 * The integer rule: a value must be a plain decimal integer; anything malformed or outside the
 * caller's bounds falls back to the caller's documented default, so a bad override never
 * misparses ("5m" is not 5) and never propagates NaN.
 *
 * The URL rule: blank is unset. `REDIS_URL=` disables the cache exactly like deleting the line.
 *
 * The store-URL rule: DATABASE_URL is canonical and wins for the engine its scheme names; PG_URL
 * and MYSQL_TEST_URL supply an engine's URL only when DATABASE_URL doesn't name that engine. An
 * engine nothing names stays null, and each caller documents its own fallback.
 */

/**
 * The environment shape every construction entry point takes — a plain string map, in practice
 * `process.env`. Always passed explicitly: no module reads the process environment itself, so a
 * test or embedder controls exactly what the library sees.
 */
export type EnvMap = Record<string, string | undefined>;

// --- Parse rules -------------------------------------------------------------------

const INT = /^-?\d+$/;

export interface IntBounds {
  min?: number;
  max?: number;
}

/** Parses one env integer under the module rule above; `bounds` default to `min: 0`. */
export function readInt(
  value: string | undefined,
  fallback: number,
  bounds?: IntBounds,
): number {
  return readIntOrNull(value, bounds) ?? fallback;
}

/** As {@link readInt}, but absent/malformed stays null — for knobs where unset means "off". */
export function readIntOrNull(
  value: string | undefined,
  bounds?: IntBounds,
): number | null {
  if (value === undefined || !INT.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  const min = bounds?.min ?? 0;
  const max = bounds?.max ?? Number.MAX_SAFE_INTEGER;
  return parsed >= min && parsed <= max ? parsed : null;
}

/** Parses a bigint for minor-unit amounts that can exceed 2^53; digits only, else the fallback. */
export function readBigInt(
  value: string | undefined,
  fallback: bigint,
): bigint {
  return readBigIntOrNull(value) ?? fallback;
}

/** As {@link readBigInt}, but absent/malformed stays null — for values a caller must reject. */
export function readBigIntOrNull(value: string | undefined): bigint | null {
  if (value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  return BigInt(value);
}

/** Applies the URL rule: blank is unset, so an empty value reads as null like a missing one. */
export function readUrl(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/** Parses a word knob: the value must match one of `allowed` exactly, else the fallback — the
 * integer rule's shape for words, so "BENCH_MODE=Contention" never half-selects a mode. */
export function readEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Split on commas, trim, drop blanks; membership stays the caller's rule. */
export function readList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Parses an opt-in flag: exactly "1" or "true" is on; anything else, blank included, is off. */
export function readFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/** True in production (NODE_ENV=production), where a required value must fail fast rather than
 * fall back to a dev stand-in. The one definition, so every gate agrees on what production is. */
export function isProduction(env: EnvMap): boolean {
  return env.NODE_ENV === 'production';
}

// --- Store URLs (the two SQL engines) -----------------------------------------------

export const isPostgresUrl = (url: string): boolean =>
  url.startsWith('postgres://') || url.startsWith('postgresql://');

export const isMysqlUrl = (url: string): boolean => url.startsWith('mysql://');

/** Every name {@link storeUrls} reads. Each env-reading family exports its list like this, so
 * the whole surface is enumerable and test/env-surface.test.ts can hold .env.example to it. */
export const STORE_URL_KEYS = [
  'DATABASE_URL',
  'PG_URL',
  'MYSQL_TEST_URL',
] as const;

export interface StoreUrls {
  postgres: string | null;
  mysql: string | null;
}

/** The one store-URL resolver (precedence in the module doc above). */
export function storeUrls(env: EnvMap): StoreUrls {
  const canonical = env.DATABASE_URL ?? '';
  return {
    postgres: isPostgresUrl(canonical) ? canonical : readUrl(env.PG_URL),
    mysql: isMysqlUrl(canonical) ? canonical : readUrl(env.MYSQL_TEST_URL),
  };
}

/**
 * The databases docker-compose.yml ships, as connection URLs. The bench and the Postgres test
 * suites fall back to these, so the lab's own tooling reaches the compose stack with no env at
 * all; a reachability probe turns their absence into a skip, never a hang or a false pass.
 */
export const LOCAL_POSTGRES_URL =
  'postgres://economy:economy@localhost:55432/economy_lab';
export const LOCAL_MYSQL_URL =
  'mysql://root:economy@localhost:53306/economy_lab';

// --- Service URLs (every optional external) ------------------------------------------

/** Every name {@link serviceUrls} reads (see {@link STORE_URL_KEYS} for the pattern). */
export const SERVICE_URL_KEYS = [
  'REDIS_URL',
  'SQS_QUEUE_URL',
  'DISPATCHER_URL',
  'PROCESSOR_URL',
  'TASKQ_DATABASE_URL',
  'TILIA_PAYEE_DATABASE_URL',
] as const;

/** The optional infrastructure a deployment names, one field per adapter; null means off. */
export interface ServiceUrls {
  /** REDIS_URL — read-through cache the store consults before the database. */
  redis: string | null;
  /** SQS_QUEUE_URL — outbox delivery through Amazon SQS; wins over the HTTP transport. */
  sqs: string | null;
  /** DISPATCHER_URL — outbox delivery over HTTP. */
  dispatcher: string | null;
  /** PROCESSOR_URL — the payout provider's HTTP endpoint; required in production. */
  processor: string | null;
  /** TASKQ_DATABASE_URL — the Postgres the optional @pwngh/taskq bridge enqueues into. */
  taskq: string | null;
  /** TILIA_PAYEE_DATABASE_URL — the Postgres holding the durable Tilia payee table. */
  tiliaPayees: string | null;
}

/** The one service-URL resolver: the names in one place, the blank-is-unset rule on each. */
export function serviceUrls(env: EnvMap): ServiceUrls {
  return {
    redis: readUrl(env.REDIS_URL),
    sqs: readUrl(env.SQS_QUEUE_URL),
    dispatcher: readUrl(env.DISPATCHER_URL),
    processor: readUrl(env.PROCESSOR_URL),
    taskq: readUrl(env.TASKQ_DATABASE_URL),
    tiliaPayees: readUrl(env.TILIA_PAYEE_DATABASE_URL),
  };
}

// --- Required secrets ----------------------------------------------------------------

/**
 * The secrets a deployed process cannot run without. The one policy, expressed once: the entry
 * point (scripts/main.ts) refuses a blank in ANY NODE_ENV, and loadConfig additionally enforces
 * it in production — both through {@link missingSecrets}, so the two checks can never disagree
 * on the list or on what counts as blank.
 */
export const REQUIRED_SECRETS = ['WEBHOOK_SECRET', 'SIGNING_SECRET'] as const;

/**
 * Optional secret-family names. SIGNING_SECRETS_PRIOR lists rotated-out signing secrets
 * (comma-separated) that checkpoints sealed under them must still verify against.
 */
export const OPTIONAL_SECRETS = ['SIGNING_SECRETS_PRIOR'] as const;

/** The required secrets that are unset or blank in `env`. */
export function missingSecrets(env: EnvMap): string[] {
  return REQUIRED_SECRETS.filter((key) => (env[key] ?? '') === '');
}
