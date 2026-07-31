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
 * A malformed service must fail at wiring time, not deep inside a request or sweep. The
 * classic slip is passing a factory (silentLogger) where its product (silentLogger()) belongs;
 * unvalidated, that surfaces days later as a retryable sweep failure that can wedge a
 * payout in SUBMITTED forever.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorker,
  createEconomy,
  defaultConfig,
  describeEnv,
  earned,
  inspectConfig,
  memoryPorts,
  mergeConfig,
  openPorts,
  preflight,
  spend,
  SYSTEM,
  systemActor,
  toAmount,
  topUp,
  userActor,
} from '#src/index.ts';
import { silentLogger } from '#src/runtime.ts';
import { hasCode } from '#test/support/capabilities.ts';

import type {
  Config,
  EnvDescription,
  PortsInit,
  PreflightIssue,
  RatesConfig,
} from '#src/index.ts';
import type { FeePolicy } from '#src/contract.ts';
import type {
  Anchor,
  Cache,
  Checkpoint,
  Clock,
  Digest,
  Dispatcher,
  Ids,
  Logger,
  Meter,
  PayeeDirectory,
  Ports,
  Processor,
  Rates,
  Scheduler,
  Signer,
  Store,
} from '#src/ports.ts';

describe('wiring rejects malformed services at startup', () => {
  test('a logger factory passed where its product belongs is CONFIG.INVALID', async () => {
    await assert.rejects(
      openPorts({}, { logger: silentLogger as unknown as Logger }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('a clock without now() is CONFIG.INVALID', async () => {
    await assert.rejects(
      openPorts({}, { clock: {} as Clock }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('a processor without submitPayout is CONFIG.INVALID', async () => {
    await assert.rejects(
      openPorts({}, { processor: {} as Processor }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('a signer without verify is CONFIG.INVALID', async () => {
    await assert.rejects(
      openPorts(
        {},
        { signer: { sign: async () => new Uint8Array() } as unknown as Signer },
      ),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('well-formed services wire clean', async () => {
    const ports = await openPorts({}, { logger: silentLogger() });
    assert.equal(typeof ports.logger.log, 'function');
    await ports.store.close();
  });

  test('an anchor without publish is CONFIG.INVALID', async () => {
    await assert.rejects(
      openPorts({}, { anchor: {} as Anchor }),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('a signature under a rotated-out secret verifies only while the priors list it', async () => {
    const payload = new TextEncoder().encode('checkpoint-root');
    const old = await openPorts(
      {},
      { secrets: { signingSecret: 'old-secret' } },
    );
    const signature = await old.signer.sign(payload);
    await old.store.close();

    const rotated = await openPorts(
      {},
      {
        secrets: {
          signingSecret: 'new-secret',
          signingSecretsPrior: ['old-secret'],
        },
      },
    );
    assert.equal(await rotated.signer.verify(payload, signature), true);
    // The new key signs fresh payloads that verify without the prior list.
    const fresh = await rotated.signer.sign(payload);
    await rotated.store.close();
    const current = await openPorts(
      {},
      { secrets: { signingSecret: 'new-secret' } },
    );
    assert.equal(await current.signer.verify(payload, fresh), true);

    // Dropping the prior secret is exactly what breaks old checkpoints.
    assert.equal(await current.signer.verify(payload, signature), false);
    await current.store.close();
  });
});

describe('preflight and openPorts agree at the construction seam', () => {
  const errors = (
    env: Record<string, string>,
    init: Parameters<typeof preflight>[1],
  ) => preflight(env, init).filter((issue) => issue.severity === 'error');

  // Production fully configured except the two policy anchors, every optional port declined.
  const productionEnv = {
    NODE_ENV: 'production',
    WEBHOOK_SECRET: 'w',
    SIGNING_SECRET: 's',
    CREDIT_BUY_RATE: '8333',
    CREDIT_BUY_SCALE: '6',
    CREDIT_PAR_RATE: '5',
    CREDIT_PAR_SCALE: '3',
    PAYOUT_RATE: '5',
    PAYOUT_SCALE: '3',
    PROCESSOR_URL: 'https://payouts.example',
    DISPATCHER_DECLINED: '1',
    PAYEES_DECLINED: '1',
    ANCHOR_DECLINED: '1',
  };

  test('policy anchors supplied via the init satisfy production for both', async () => {
    const init = {
      config: { maturityHorizonMs: { card: 0 }, velocityLimitMinor: 100_000n },
      logger: silentLogger(),
    };
    assert.deepEqual(errors(productionEnv, init), []);
    const ports = await openPorts(productionEnv, init);
    assert.equal(ports.config.velocityLimitMinor, 100_000n);
    await ports.store.close();
  });

  test('an object passed where the dispatch function belongs fails both', async () => {
    const init = {
      dispatcher: { dispatch: async () => {} } as unknown as Dispatcher,
      logger: silentLogger(),
    };
    assert.ok(errors({}, init).some((issue) => issue.path === 'dispatcher'));
    await assert.rejects(openPorts({}, init), hasCode('CONFIG.INVALID'));
  });

  test('a payees directory without status fails both', async () => {
    const init = {
      payees: {} as PayeeDirectory,
      logger: silentLogger(),
    };
    assert.ok(errors({}, init).some((issue) => issue.path === 'payees'));
    await assert.rejects(openPorts({}, init), hasCode('CONFIG.INVALID'));
  });

  test('a decline flag shadowing a configured source is a warning, not an error', () => {
    const env = {
      ...productionEnv,
      DISPATCHER_URL: 'https://dispatch.example',
    };
    const init = {
      config: { maturityHorizonMs: { card: 0 }, velocityLimitMinor: 100_000n },
    };
    assert.deepEqual(errors(env, init), []);
    assert.ok(
      preflight(env, init).some(
        (issue) => issue.severity === 'warning' && issue.path === 'dispatcher',
      ),
    );
  });
});

/**
 * `preflight` promises that an issue with severity 'error' is exactly what `openPorts` throws on.
 * Hand-written issue tests hold while the next slot diverges, so both describes below drive one
 * environment through both readings and require the two verdicts to match — per slot, per posture,
 * over every kind or shape the seam admits. One axis is what the environment selects (`Q97`), the
 * other is what the init supplies (`Q103`); the harness they share lives here so the two cannot
 * drift apart, and `test/dedupe.test.ts` would not see it if it did.
 *
 * **Agreement alone is not the property.** `openPorts` refuses *through* `preflight`, so a preflight
 * that refuses something servable is agreed with by construction: the two readings match and the
 * boot is gone. Each cell therefore declares the postures it is servable in, and both readings are
 * held to that. Measured: without the declaration, a preflight rewritten to refuse a named URL even
 * when the port is supplied passes on agreement alone.
 */
type Posture = 'development' | 'production';

interface Cell {
  /** What the cell states, read back by the failure message. */
  readonly what: string;
  readonly env: Record<string, string>;
  /** A factory, so a cell that supplies a port hands each posture its own. */
  readonly init: () => PortsInit;
  /** The postures this configuration boots in. Empty means neither reading may accept it. */
  readonly servable: readonly Posture[];
  /**
   * The fragment a developer has to be handed when this cell is refused — the member at fault or
   * the value to pass instead. Required of any cell that is refused in either posture, and
   * `assertVerdict` refuses a cell that is refused without one.
   *
   * Requiring only that the two readings carry the *same* sentence proves nothing: `openPorts`
   * refuses through `assertPreflight`, so the throw is assembled from the issues and a paraphrase
   * travels into both. Measured — a preflight rewritten to replace every probe's sentence with
   * "the <slot> port is the wrong shape." passed the same-sentence assertion. This pin is the
   * independent anchor those refusals otherwise lack.
   */
  readonly refusal?: string;
}

const BOTH: readonly Posture[] = ['development', 'production'];
const NEITHER: readonly Posture[] = [];

// Production, complete: both secrets, every rate knob, the payout provider, both policy anchors,
// and the three optional ports declined. Nothing in it touches a selection slot or supplies a port,
// so a cell's only reason to be refused is the thing it states.
const COMPLETE_PRODUCTION: Record<string, string> = {
  NODE_ENV: 'production',
  WEBHOOK_SECRET: 'w',
  SIGNING_SECRET: 's',
  CREDIT_BUY_RATE: '8333',
  CREDIT_BUY_SCALE: '6',
  CREDIT_PAR_RATE: '5',
  CREDIT_PAR_SCALE: '3',
  PAYOUT_RATE: '5',
  PAYOUT_SCALE: '3',
  PROCESSOR_URL: 'https://payouts.example',
  MATURITY_HORIZON_CARD_MS: '604800000',
  VELOCITY_LIMIT_MINOR: '5000000',
  DISPATCHER_DECLINED: '1',
  PAYEES_DECLINED: '1',
  ANCHOR_DECLINED: '1',
};

const POSTURES: readonly {
  name: Posture;
  base: Record<string, string>;
}[] = [
  { name: 'development', base: {} },
  { name: 'production', base: COMPLETE_PRODUCTION },
];

interface Comparison {
  readonly slot: string;
  readonly kind: string;
  readonly cell: Cell;
  readonly posture: (typeof POSTURES)[number];
}

/** Every (slot, kind, cell, posture) a roster of cells names. */
function everyCell(
  slots: Record<string, Record<string, readonly Cell[]>>,
): readonly Comparison[] {
  const out: Comparison[] = [];
  for (const [slot, kinds] of Object.entries(slots)) {
    for (const [kind, cells] of Object.entries(kinds)) {
      for (const cell of cells) {
        for (const posture of POSTURES) {
          out.push({ slot, kind, cell, posture });
        }
      }
    }
  }
  return out;
}

/** Both readings of one (env, init): what preflight refuses, and what openPorts refuses. */
async function bothReadings(
  cell: Cell,
  base: Record<string, string>,
): Promise<{ refusals: readonly PreflightIssue[]; thrown: Error | null }> {
  const env = { ...base, ...cell.env };
  // The cell's own logger wins, so a cell about the logger slot states its own value.
  const init = { logger: silentLogger(), ...cell.init() };
  const refusals = preflight(env, init).filter(
    (found) => found.severity === 'error',
  );
  let thrown: Error | null = null;
  let opened: Awaited<ReturnType<typeof openPorts>> | null = null;
  try {
    opened = await openPorts(env, init);
  } catch (error) {
    thrown = error as Error;
  }
  try {
    await opened?.store.close();
  } catch {
    // A bag that opened over a mis-shaped store has nothing to close, and the verdict above is
    // what this reads. Without the guard the harness dies here and reports its own TypeError
    // instead of the cell that was wrongly accepted.
  }
  return { refusals, thrown };
}

const firstLine = (message: string): string => message.split('\n')[0]!;

function assertVerdict(
  where: string,
  cell: Cell,
  servable: boolean,
  reading: { refusals: readonly PreflightIssue[]; thrown: Error | null },
): void {
  const { refusals, thrown } = reading;
  const said = refusals.length
    ? refusals.map((found) => `${found.code} ${found.path}`).join(', ')
    : 'clean';
  const seen = `${where}\n  the table says ${servable ? 'servable' : 'refused'}\n  preflight: ${said}\n  openPorts: ${thrown ? firstLine(thrown.message) : 'opened'}`;
  // Q97: the two readings, on one environment.
  assert.equal(refusals.length > 0, thrown !== null, seen);
  // And the verdict the configuration has coming, so an agreed-upon refusal of a servable
  // deployment fails here rather than passing as agreement.
  assert.equal(thrown === null, servable, seen);
  // The same verdict for the same reason: what preflight printed is the sentence the refusal
  // carries, not a paraphrase a developer has to reconcile with it.
  for (const found of refusals) {
    assert.ok(
      thrown!.message.includes(found.message),
      `${where}\n  preflight said "${firstLine(found.message)}"\n  openPorts said "${firstLine(thrown!.message)}"`,
    );
  }
  if (thrown !== null) {
    assert.ok(
      cell.refusal !== undefined,
      `${where}\n  a cell that is refused has to state the fragment its refusal hands over`,
    );
    assert.ok(
      thrown.message.includes(cell.refusal),
      `${where}\n  the refusal has to hand over "${cell.refusal}"\n  it said "${thrown.message.replace(/\n/g, ' ')}"`,
    );
  }
}

/**
 * Drives every cell through both readings. It returns the counts of what was examined rather than
 * the absence of failures: a roster that stopped iterating satisfies every assertion inside.
 */
async function driveCells(
  slots: Record<string, Record<string, readonly Cell[]>>,
): Promise<{
  compared: string[];
  booted: string[];
  pinned: string[];
  outcomes: Map<string, Set<string>>;
}> {
  const compared: string[] = [];
  const booted: string[] = [];
  const pinned: string[] = [];
  const outcomes = new Map<string, Set<string>>();
  for (const { slot, kind, cell, posture } of everyCell(slots)) {
    const where = `${slot} ${kind}, ${posture.name}: ${cell.what}`;
    const servable = cell.servable.includes(posture.name);
    const reading = await bothReadings(cell, posture.base);
    assertVerdict(where, cell, servable, reading);
    compared.push(where);
    if (reading.thrown === null) booted.push(where);
    else pinned.push(`${where} -> ${cell.refusal}`);
    outcomes.set(
      slot,
      (outcomes.get(slot) ?? new Set<string>()).add(
        reading.thrown === null ? 'clean' : 'refused',
      ),
    );
  }
  return { compared, booted, pinned, outcomes };
}

// Every slot has to have produced both outcomes, or its rows prove nothing about the other.
function assertBothOutcomes(outcomes: Map<string, Set<string>>): void {
  for (const [slot, seen] of outcomes) {
    assert.deepEqual(
      [...seen].sort(),
      ['clean', 'refused'],
      `${slot} never both booted and refused, so its agreement proves nothing`,
    );
  }
}

/**
 * The axis the environment selects: `DATABASE_URL`, `REDIS_URL`, `SQS_QUEUE_URL`. The cells are
 * keyed by the kind unions {@link EnvDescription} publishes, so a third SQL engine or a fifth
 * dispatcher transport added to the lab fails the typecheck until its cells are written.
 *
 * `supplied` and `declined` are the init's answer rather than the environment's, so the two
 * rosters below subtract them by name and the describe over `describeEnv` drives them instead.
 * The subtraction is written out so a kind added to either union still lands in one place or the
 * other rather than in neither.
 */
type SelectedStore = Exclude<EnvDescription['store']['kind'], 'supplied'>;
type SelectedCache = Exclude<
  EnvDescription['cache']['kind'],
  'supplied' | 'declined'
>;
describe('preflight and openPorts reach the same verdict on every selected slot', () => {
  const PG = 'postgres://econ:secret@db:5432/economy';
  const MY = 'mysql://econ:secret@db:3306/economy';
  const MONGO = 'mongodb://db:27017/economy';
  const REDIS = 'redis://cache:6379';
  const SQS = 'https://sqs.us-east-1.amazonaws.com/1/economy';

  const aStore = (): Store =>
    memoryPorts({ signingKey: 'agreement-signing-key' }).store;
  const aCache = (): Cache => ({
    get: async () => null,
    set: async () => {},
    invalidate: async () => {},
  });
  const aDispatcher: Dispatcher = async () => {};

  const STORE_CELLS: Record<SelectedStore, readonly Cell[]> = {
    memory: [
      {
        what: 'no DATABASE_URL',
        env: {},
        init: () => ({}),
        servable: BOTH,
      },
    ],
    postgres: [
      {
        what: 'a postgres:// URL and no store',
        refusal: 'Install @pwngh/economy-postgres',
        env: { DATABASE_URL: PG },
        init: () => ({}),
        servable: NEITHER,
      },
      {
        what: 'a postgres:// URL with the store supplied',
        env: { DATABASE_URL: PG },
        init: () => ({ store: aStore() }),
        servable: BOTH,
      },
    ],
    mysql: [
      {
        what: 'a mysql:// URL and no store',
        refusal: 'Install @pwngh/economy-mysql',
        env: { DATABASE_URL: MY },
        init: () => ({}),
        servable: NEITHER,
      },
      {
        what: 'a mysql:// URL with the store supplied',
        env: { DATABASE_URL: MY },
        init: () => ({ store: aStore() }),
        servable: BOTH,
      },
    ],
    unsupported: [
      {
        what: 'a mongodb:// URL and no store',
        refusal:
          'DATABASE_URL is not a postgres:// or mysql:// connection string.',
        env: { DATABASE_URL: MONGO },
        init: () => ({}),
        servable: NEITHER,
      },
      {
        what: 'a mongodb:// URL with the store supplied',
        env: { DATABASE_URL: MONGO },
        init: () => ({ store: aStore() }),
        servable: BOTH,
      },
    ],
  };

  const CACHE_CELLS: Record<SelectedCache, readonly Cell[]> = {
    none: [{ what: 'no REDIS_URL', env: {}, init: () => ({}), servable: BOTH }],
    redis: [
      {
        what: 'a redis:// URL and no cache',
        refusal: 'Install @pwngh/economy-redis',
        env: { REDIS_URL: REDIS },
        init: () => ({}),
        servable: NEITHER,
      },
      {
        what: 'a redis:// URL with the cache supplied',
        env: { REDIS_URL: REDIS },
        init: () => ({ cache: aCache() }),
        servable: BOTH,
      },
      {
        what: 'a redis:// URL with the cache declined',
        env: { REDIS_URL: REDIS },
        init: () => ({ cache: false }),
        servable: BOTH,
      },
    ],
  };

  // Every dispatcher cell states DISPATCHER_DECLINED itself: the production baseline declines all
  // three optional ports, and a cell about the transport cannot inherit a decline of it.
  const DISPATCHER_CELLS: Record<
    EnvDescription['dispatcher']['kind'],
    readonly Cell[]
  > = {
    missing: [
      {
        what: 'no transport named and no decline',
        refusal:
          'Production requires dispatcher to be set or explicitly declined',
        env: { DISPATCHER_DECLINED: '' },
        init: () => ({}),
        // Production requires each optional port set or explicitly declined; development does not.
        servable: ['development'],
      },
    ],
    http: [
      {
        what: 'a DISPATCHER_URL and no dispatcher',
        env: {
          DISPATCHER_DECLINED: '',
          DISPATCHER_URL: 'https://events.example/ingest',
        },
        init: () => ({}),
        // The one transport the lab still opens itself.
        servable: BOTH,
      },
    ],
    sqs: [
      {
        what: 'an SQS queue URL and no dispatcher',
        refusal: 'Install @pwngh/economy-sqs',
        env: { DISPATCHER_DECLINED: '', SQS_QUEUE_URL: SQS },
        init: () => ({}),
        servable: NEITHER,
      },
      {
        what: 'an SQS queue URL with the dispatcher supplied',
        env: { DISPATCHER_DECLINED: '', SQS_QUEUE_URL: SQS },
        init: () => ({ dispatcher: aDispatcher }),
        servable: BOTH,
      },
    ],
    declined: [
      {
        what: 'an SQS queue URL with the dispatcher declined',
        env: { DISPATCHER_DECLINED: '1', SQS_QUEUE_URL: SQS },
        init: () => ({}),
        servable: BOTH,
      },
    ],
    'in-process': [
      {
        what: 'a dispatch function and no transport named',
        env: { DISPATCHER_DECLINED: '' },
        init: () => ({ dispatcher: aDispatcher }),
        servable: BOTH,
      },
    ],
  };

  const SLOTS: Record<string, Record<string, readonly Cell[]>> = {
    store: STORE_CELLS,
    cache: CACHE_CELLS,
    dispatcher: DISPATCHER_CELLS,
  };

  test('the two readings never disagree, and neither refuses a servable deployment', async () => {
    const { compared, booted, pinned, outcomes } = await driveCells(SLOTS);

    assert.equal(compared.length, 34, compared.join('\n'));
    assert.equal(booted.length, 23, booted.join('\n'));
    assert.equal(pinned.length, 11, pinned.join('\n'));
    assert.deepEqual(
      [...outcomes.keys()].sort(),
      ['cache', 'dispatcher', 'store'],
      'a slot named by the selection was never driven',
    );
    assertBothOutcomes(outcomes);
  });
});

/**
 * The other axis: what the init supplies. `preflight` owes the same contract for the bag as for the
 * environment, and it was blind to the shape of nine of the fifteen ports — three had no probe
 * anywhere, and a mis-shaped `rates` escaped as a raw `TypeError` out of `node_modules`.
 *
 * The cells are keyed by `PortsInit`'s own port fields, so a sixteenth port added to the published
 * init fails the typecheck here until its cells are written. Each declares the postures it is
 * servable in, for the reason the harness above states: agreement alone would hold while both
 * readings refused every bag.
 */
describe('preflight and openPorts reach the same verdict on every supplied port', () => {
  type PortSlot = Exclude<keyof PortsInit, 'config' | 'secrets'>;

  // Real products, so a servable cell hands over what a host would: memoryPorts wires the lab's own
  // clock, ids, digest, signer, processor, rate source and fee policy.
  const real = (): Ports => memoryPorts({ signingKey: 'shape-signing-key' });

  const KNOBS = {
    buyRate: 8_333n,
    buyScale: 6,
    parRate: 5n,
    parScale: 3,
    payoutRate: 5n,
    payoutScale: 3,
  };

  // A cell about a declinable port clears that port's decline flag, or the production baseline's
  // decline would be the reason for the verdict instead of the shape.
  const undeclined = (flag: string): Record<string, string> => ({ [flag]: '' });

  const SHAPE_CELLS: Record<PortSlot, readonly Cell[]> = {
    store: [
      {
        what: 'an empty object',
        refusal: 'store.ledger is missing',
        env: {},
        init: () => ({ store: {} as Store }),
        servable: NEITHER,
      },
      {
        what: 'a store missing one sub-store',
        refusal: 'store.sagas is missing',
        env: {},
        init: () => {
          const { sagas, ...rest } = real().store;
          void sagas;
          return { store: rest as unknown as Store };
        },
        servable: NEITHER,
      },
      {
        what: 'a whole store',
        env: {},
        init: () => ({ store: real().store }),
        servable: BOTH,
      },
    ],
    clock: [
      {
        what: 'an empty object',
        refusal: 'clock.now is not a function',
        env: {},
        init: () => ({ clock: {} as Clock }),
        servable: NEITHER,
      },
      {
        what: 'a real clock',
        env: {},
        init: () => ({ clock: real().clock }),
        servable: BOTH,
      },
    ],
    ids: [
      {
        what: 'an empty object',
        refusal: 'ids.next is not a function',
        env: {},
        init: () => ({ ids: {} as Ids }),
        servable: NEITHER,
      },
      {
        what: 'a real id source',
        env: {},
        init: () => ({ ids: real().ids }),
        servable: BOTH,
      },
    ],
    digest: [
      {
        what: 'an empty object',
        refusal: 'digest.hash is not a function',
        env: {},
        init: () => ({ digest: {} as Digest }),
        servable: NEITHER,
      },
      {
        what: 'a real digest',
        env: {},
        init: () => ({ digest: real().digest }),
        servable: BOTH,
      },
    ],
    signer: [
      {
        what: 'a signer that signs but cannot verify',
        refusal: 'signer.verify is not a function',
        env: {},
        init: () => ({
          signer: { sign: async () => new Uint8Array() } as unknown as Signer,
        }),
        servable: NEITHER,
      },
      {
        what: 'a real signer',
        env: {},
        init: () => ({ signer: real().signer }),
        servable: BOTH,
      },
    ],
    processor: [
      {
        what: 'an empty object',
        refusal: 'processor.submitPayout is not a function',
        env: {},
        init: () => ({ processor: {} as Processor }),
        servable: NEITHER,
      },
      {
        what: 'a real processor',
        env: {},
        init: () => ({ processor: real().processor }),
        servable: BOTH,
      },
    ],
    rates: [
      {
        what: 'an empty object — neither a live source nor the knobs',
        refusal: 'rates is malformed: pass a live Rates source',
        env: {},
        init: () => ({ rates: {} as Rates }),
        servable: NEITHER,
      },
      {
        what: 'a source that pays out but cannot quote a buy rate',
        refusal: 'rates.par is not a function',
        env: {},
        init: () => ({
          rates: {
            payout: async () => ({ rate: 5n, scale: 3, rateId: 'p' }),
          } as unknown as Rates,
        }),
        servable: NEITHER,
      },
      {
        what: 'a buy rate written as a string instead of a bigint',
        refusal: 'rates is malformed: pass a live Rates source',
        env: {},
        init: () => ({
          rates: { ...KNOBS, buyRate: '8333' } as unknown as RatesConfig,
        }),
        servable: NEITHER,
      },
      {
        // Not a shape fault: a table that would let a credit cash out for more than it was bought
        // at. openPorts refuses it, so the deploy gate has to as well.
        what: 'knobs whose buy rate sits below par',
        refusal: 'Rates must hold buy >= par >= payout',
        env: {},
        init: () => ({ rates: { ...KNOBS, buyRate: 1n, buyScale: 3 } }),
        servable: NEITHER,
      },
      {
        // The env knobs, not the init. Only production reads them, so the same table is servable in
        // development and refused in production.
        what: 'env knobs whose payout rate sits above par',
        refusal: 'Rates must hold buy >= par >= payout',
        env: { PAYOUT_RATE: '9', PAYOUT_SCALE: '3' },
        init: () => ({}),
        servable: ['development'],
      },
      {
        what: 'the exact integer knobs',
        env: {},
        init: () => ({ rates: KNOBS }),
        servable: BOTH,
      },
      {
        what: 'a live rate source',
        env: {},
        init: () => ({ rates: real().rates }),
        servable: BOTH,
      },
    ],
    pricing: [
      {
        what: 'an object carrying the fee policy instead of the policy',
        refusal:
          'pricing is not a function; pass the fee policy function itself',
        env: {},
        init: () => ({ pricing: {} as unknown as FeePolicy }),
        servable: NEITHER,
      },
      {
        what: 'a real fee policy',
        env: {},
        init: () => ({ pricing: real().pricing }),
        servable: BOTH,
      },
    ],
    logger: [
      {
        what: 'the logger factory where its product belongs',
        refusal: 'logger.log is not a function',
        env: {},
        init: () => ({ logger: silentLogger as unknown as Logger }),
        servable: NEITHER,
      },
      {
        what: "the factory's product",
        env: {},
        init: () => ({ logger: silentLogger() }),
        servable: BOTH,
      },
    ],
    meter: [
      {
        what: 'a meter that counts but cannot observe',
        refusal: 'meter.observe is not a function',
        env: {},
        init: () => ({ meter: { count: () => {} } as unknown as Meter }),
        servable: NEITHER,
      },
      {
        what: 'a real meter',
        env: {},
        init: () => ({ meter: real().meter }),
        servable: BOTH,
      },
    ],
    cache: [
      {
        what: 'an empty object',
        refusal: 'cache.get is not a function',
        env: {},
        init: () => ({ cache: {} as Cache }),
        servable: NEITHER,
      },
      {
        what: 'a whole cache',
        env: {},
        init: () => ({
          cache: {
            get: async () => null,
            set: async () => {},
            invalidate: async () => {},
          },
        }),
        servable: BOTH,
      },
      {
        what: 'an explicit decline',
        env: {},
        init: () => ({ cache: false }),
        servable: BOTH,
      },
    ],
    dispatcher: [
      {
        what: 'an object carrying the dispatch function',
        refusal: 'pass the dispatch function itself',
        env: undeclined('DISPATCHER_DECLINED'),
        init: () => ({
          dispatcher: { dispatch: async () => {} } as unknown as Dispatcher,
        }),
        servable: NEITHER,
      },
      {
        what: 'the dispatch function itself',
        env: undeclined('DISPATCHER_DECLINED'),
        init: () => ({ dispatcher: (async () => {}) as Dispatcher }),
        servable: BOTH,
      },
      {
        what: 'an explicit decline',
        env: undeclined('DISPATCHER_DECLINED'),
        init: () => ({ dispatcher: false }),
        servable: BOTH,
      },
    ],
    payees: [
      {
        what: 'an empty object',
        refusal: 'payees.status is not a function',
        env: undeclined('PAYEES_DECLINED'),
        init: () => ({ payees: {} as PayeeDirectory }),
        servable: NEITHER,
      },
      {
        what: 'a whole payee directory',
        env: undeclined('PAYEES_DECLINED'),
        init: () => ({
          payees: {
            status: async () => ({ state: 'CLEARED' }),
          } as PayeeDirectory,
        }),
        servable: BOTH,
      },
      {
        what: 'an explicit decline',
        env: undeclined('PAYEES_DECLINED'),
        init: () => ({ payees: false }),
        servable: BOTH,
      },
    ],
    anchor: [
      {
        what: 'an empty object',
        refusal: 'anchor.publish is not a function',
        env: undeclined('ANCHOR_DECLINED'),
        init: () => ({ anchor: {} as Anchor }),
        servable: NEITHER,
      },
      {
        what: 'a whole anchor',
        env: undeclined('ANCHOR_DECLINED'),
        init: () => ({ anchor: { publish: async () => {} } as Anchor }),
        servable: BOTH,
      },
      {
        what: 'an explicit decline',
        env: undeclined('ANCHOR_DECLINED'),
        init: () => ({ anchor: false }),
        servable: BOTH,
      },
    ],
    scheduler: [
      {
        what: 'an empty object',
        refusal: 'scheduler.every is not a function',
        env: {},
        init: () => ({ scheduler: {} as Scheduler }),
        servable: NEITHER,
      },
      {
        what: 'a whole scheduler',
        env: {},
        init: () => ({ scheduler: { every: () => () => {} } as Scheduler }),
        servable: BOTH,
      },
      {
        what: 'an explicit decline',
        env: {},
        init: () => ({ scheduler: false }),
        servable: BOTH,
      },
    ],
  };

  // The roster read as one slot per kind key, so the harness above drives it unchanged.
  const SLOTS: Record<
    string,
    Record<string, readonly Cell[]>
  > = Object.fromEntries(
    Object.entries(SHAPE_CELLS).map(([slot, cells]) => [
      slot,
      { supplied: cells },
    ]),
  );

  test('every port an init can supply has a shape probe, and it agrees with the boot', async () => {
    const { compared, booted, pinned, outcomes } = await driveCells(SLOTS);

    // The counts of what was examined, not the absence of failures.
    assert.equal(compared.length, 82, compared.join('\n'));
    assert.equal(booted.length, 43, booted.join('\n'));
    // And the refusals whose wording was held to the fragment it has to hand over.
    assert.equal(pinned.length, 39, pinned.join('\n'));
    // The roster itself, so a slot dropped from the table shows up in the diff rather than as a
    // smaller number nobody reads.
    assert.deepEqual(
      [...outcomes.keys()].sort(),
      [
        'anchor',
        'cache',
        'clock',
        'digest',
        'dispatcher',
        'ids',
        'logger',
        'meter',
        'payees',
        'pricing',
        'processor',
        'rates',
        'scheduler',
        'signer',
        'store',
      ],
      'a port PortsInit declares was never driven',
    );
    assertBothOutcomes(outcomes);
  });

  test('a mis-shaped port is a named refusal, never a raw TypeError', async () => {
    const examined: string[] = [];
    for (const [slot, cells] of Object.entries(SHAPE_CELLS)) {
      for (const cell of cells.filter((one) => one.servable.length === 0)) {
        let thrown: unknown = null;
        try {
          await openPorts(cell.env, { logger: silentLogger(), ...cell.init() });
        } catch (error) {
          thrown = error;
        }
        const where = `${slot}: ${cell.what}`;
        assert.ok(thrown !== null, `${where} opened`);
        // A TypeError out of node_modules names no port and states no fix. The refusal has to be
        // the lab's own coded one.
        const seen = `${where} refused as ${(thrown as Error).constructor.name}: ${(thrown as Error).message}`;
        assert.equal((thrown as Error).name, 'EconomyError', seen);
        assert.equal(
          (thrown as { code?: string }).code,
          'CONFIG.INVALID',
          seen,
        );
        examined.push(where);
      }
    }
    assert.equal(examined.length, 19, examined.join('\n'));
  });
});

/**
 * The third axis, and the one that moved money: what the init supplies as *policy*. `config` and
 * `secrets` are not ports, so `PORT_SHAPES` cannot key them and the shape describe above is blind
 * to them by construction.
 *
 * The env path has always bounded these knobs — `PLATFORM_FEE_BPS=99999` resolves to 1530 — and
 * the init path bounded none of them. Measured before the fix: `config: { platformFeeBps: 99999 }`
 * opened with preflight clean, and a 1,000-credit sale with one 100% recipient booked
 * `REVENUE -1000` with **no seller leg at all**; at -500 the fee vanished and the seller took the
 * whole 1,000; `'lots'` opened clean and died on the first spend with a raw `SyntaxError`.
 *
 * Every cell states its verdict as a literal against a value chosen to sit outside the bound. None
 * of them reads the bounds table — a cell that derived its expectation from the thing it guards
 * would agree with any bound, including a wrong one.
 */
describe('preflight and openPorts reach the same verdict on every supplied policy knob', () => {
  // A knob whose value sits outside the bound. `wanted` and `at` spell the refusal a caller has
  // to be handed, written out rather than read off the table the refusal comes from.
  const knob = (
    name: keyof Config,
    value: unknown,
    wanted: string,
    at = '',
  ): Cell => ({
    what: `${name} set to ${String(value)}`,
    refusal: `config.${name}${at} must be ${wanted}`,
    env: {},
    init: () => ({ config: { [name]: value } as Partial<Config> }),
    servable: NEITHER,
  });

  // A knob inside the bound. Every knob needs one, or "bad values are refused" is satisfiable by
  // refusing all of them.
  const fine = (name: keyof Config, value: unknown): Cell => ({
    what: `${name} set to ${String(value)}`,
    env: {},
    init: () => ({ config: { [name]: value } as Partial<Config> }),
    servable: BOTH,
  });

  // The cell roster is keyed by Config's own fields, so a knob added to the published Config
  // leaves this short a key and fails the typecheck until its cells are written.
  const KNOB_CELLS: Record<keyof Config, readonly Cell[]> = {
    freshnessWindowMs: [
      knob('freshnessWindowMs', -1, 'a whole number from 0 to 86400000'),
      // The ceiling, driven because it is the value that turns the skew gate off rather than
      // narrowing it: past it every inbound webhook is fresh.
      knob(
        'freshnessWindowMs',
        86_400_001,
        'a whole number from 0 to 86400000',
      ),
      fine('freshnessWindowMs', 30_000),
    ],
    maxPayoutAttempts: [
      knob('maxPayoutAttempts', 0, 'a whole number of at least 1'),
      fine('maxPayoutAttempts', 3),
    ],
    maxOutboxAttempts: [
      knob('maxOutboxAttempts', 0, 'a whole number of at least 1'),
      fine('maxOutboxAttempts', 4),
    ],
    maxInboxAttempts: [
      knob('maxInboxAttempts', 0, 'a whole number of at least 1'),
      fine('maxInboxAttempts', 5),
    ],
    maxSubscriptionAttempts: [
      knob('maxSubscriptionAttempts', 0, 'a whole number of at least 1'),
      fine('maxSubscriptionAttempts', 6),
    ],
    maxPayoutAgeMs: [
      knob('maxPayoutAgeMs', -1, 'a whole number of at least 0'),
      fine('maxPayoutAgeMs', 86_400_000),
    ],
    platformFeeBps: [
      // The entry's own value. 99999 bps is 999.99%, and it committed.
      knob('platformFeeBps', 99_999, 'a whole number from 0 to 10000'),
      knob('platformFeeBps', -500, 'a whole number from 0 to 10000'),
      // The wrong type, which opened clean and died inside pricing on the first sale.
      knob('platformFeeBps', 'lots', 'a whole number from 0 to 10000'),
      fine('platformFeeBps', 3_000),
    ],
    payoutFeeBps: [
      knob('payoutFeeBps', 50_000, 'a whole number from 0 to 10000'),
      fine('payoutFeeBps', 150),
    ],
    velocityLimitMinor: [
      knob('velocityLimitMinor', -1n, 'a bigint of at least 0'),
      knob('velocityLimitMinor', 5_000_000, 'a bigint of at least 0'),
      fine('velocityLimitMinor', 5_000_000n),
    ],
    velocityInflowLimitMinor: [
      knob('velocityInflowLimitMinor', -1n, 'a bigint of at least 0'),
      fine('velocityInflowLimitMinor', 2_000_000n),
    ],
    velocityOutflowLimitMinor: [
      knob('velocityOutflowLimitMinor', -1n, 'a bigint of at least 0'),
      fine('velocityOutflowLimitMinor', 2_000_000n),
    ],
    velocityWindowMs: [
      knob('velocityWindowMs', 0, 'a whole number of at least 1'),
      fine('velocityWindowMs', 3_600_000),
    ],
    subscriptionPriceMinMinor: [
      knob('subscriptionPriceMinMinor', -1n, 'a bigint of at least 0'),
      fine('subscriptionPriceMinMinor', 10_000n),
    ],
    subscriptionPriceMaxMinor: [
      knob('subscriptionPriceMaxMinor', -1n, 'a bigint of at least 0'),
      fine('subscriptionPriceMaxMinor', 1_000_000n),
    ],
    topUpBundlesMinor: [
      knob(
        'topUpBundlesMinor',
        [0n],
        'a bigint from 1 to 1000000000000000',
        '[0]',
      ),
      knob(
        'topUpBundlesMinor',
        [1_200],
        'a bigint from 1 to 1000000000000000',
        '[0]',
      ),
      fine('topUpBundlesMinor', [1_200n, 12_000n]),
    ],
    maturityHorizonMs: [
      knob(
        'maturityHorizonMs',
        { card: -1 },
        'a whole number of at least 0',
        '.card',
      ),
      fine('maturityHorizonMs', { card: 604_800_000 }),
    ],
    payoutSla: [
      knob(
        'payoutSla',
        { PENDING: -1 },
        'a whole number of at least 0',
        '.PENDING',
      ),
      fine('payoutSla', { PENDING: 15_000 }),
    ],
    payoutMinimumEarnedMinor: [
      knob('payoutMinimumEarnedMinor', -1n, 'a bigint of at least 0'),
      fine('payoutMinimumEarnedMinor', 2_000_000n),
    ],
    payoutMinIntervalMs: [
      knob('payoutMinIntervalMs', -1, 'a whole number of at least 0'),
      fine('payoutMinIntervalMs', 86_400_000),
    ],
    pauseStartMs: [
      knob('pauseStartMs', -1, 'a whole number of at least 0'),
      fine('pauseStartMs', null),
    ],
    pauseEndMs: [
      knob('pauseEndMs', -1, 'a whole number of at least 0'),
      fine('pauseEndMs', null),
    ],
    dbPoolMax: [
      knob('dbPoolMax', -1, 'a whole number of at least 0'),
      fine('dbPoolMax', 20),
    ],
    dbConnectTimeoutMs: [
      // Zero reads as "no timeout" to both drivers, the very hang the knob bounds.
      knob('dbConnectTimeoutMs', 0, 'a whole number of at least 1'),
      fine('dbConnectTimeoutMs', 10_000),
    ],
    platformShards: [
      knob('platformShards', 0, 'a whole number of at least 1'),
      fine('platformShards', 2),
    ],
    accrualDrain: [
      knob('accrualDrain', 'yes', 'true or false'),
      fine('accrualDrain', true),
    ],
  };

  // The env half of the same table. The catalog is the one knob loadConfig refuses rather than
  // defaults, and preflight was blind to it: measured clean at deploy time, CONFIG.INVALID at boot.
  const ENV_CELLS: Record<string, readonly Cell[]> = {
    'env catalog': [
      {
        what: 'a purchase catalog the resolver throws on',
        refusal:
          'TOP_UP_BUNDLES_MINOR must be a comma-separated list of positive minor-unit counts.',
        env: { TOP_UP_BUNDLES_MINOR: 'oops' },
        init: () => ({}),
        servable: NEITHER,
      },
      {
        what: 'a purchase catalog the resolver parses',
        env: { TOP_UP_BUNDLES_MINOR: '1200,12000' },
        init: () => ({}),
        servable: BOTH,
      },
    ],
  };

  /**
   * The two production policy anchors, which are not a bound on a knob but a demand that the knob
   * be stated at all. `openPorts` refuses a production deployment missing either, and the one test
   * that covered them asserted the satisfied direction alone — anchors supplied through
   * `init.config` cleared both readings, and nothing drove a missing one through either.
   *
   * `MATURITY_HORIZON_CARD_MS` is the horizon every other rail defaults to and
   * `VELOCITY_LIMIT_MINOR` is the spend ceiling, so a deployment that boots without them is not a
   * deployment with a mild default. Each anchor is its own slot, so both have to produce a clean
   * boot and a refusal on their own rather than between them.
   */
  const anchorless = (name: string): Record<string, string> => ({ [name]: '' });

  const ANCHOR_CELLS: Record<string, readonly Cell[]> = {
    'anchor MATURITY_HORIZON_CARD_MS': [
      {
        what: 'the card horizon named nowhere',
        refusal:
          'MATURITY_HORIZON_CARD_MS is required in production but missing.',
        env: anchorless('MATURITY_HORIZON_CARD_MS'),
        init: () => ({}),
        // Outside production the horizons default to 0, which is what the zero-config quickstart
        // spends against.
        servable: ['development'],
      },
      {
        what: 'the card horizon supplied through init.config',
        env: anchorless('MATURITY_HORIZON_CARD_MS'),
        init: () => ({ config: { maturityHorizonMs: { card: 604_800_000 } } }),
        servable: BOTH,
      },
      {
        what: 'the card horizon named by the environment',
        env: { MATURITY_HORIZON_CARD_MS: '604800000' },
        init: () => ({}),
        servable: BOTH,
      },
    ],
    'anchor VELOCITY_LIMIT_MINOR': [
      {
        what: 'the spend ceiling named nowhere',
        refusal: 'VELOCITY_LIMIT_MINOR is required in production but missing.',
        env: anchorless('VELOCITY_LIMIT_MINOR'),
        init: () => ({}),
        servable: ['development'],
      },
      {
        what: 'the spend ceiling supplied through init.config',
        env: anchorless('VELOCITY_LIMIT_MINOR'),
        init: () => ({ config: { velocityLimitMinor: 5_000_000n } }),
        servable: BOTH,
      },
      {
        what: 'the spend ceiling named by the environment',
        env: { VELOCITY_LIMIT_MINOR: '5000000' },
        init: () => ({}),
        servable: BOTH,
      },
    ],
    // Both at once, because the refusal lists every missing anchor in one fault rather than
    // failing on the first: a host fixing one at a time never sees the second.
    'anchor pair': [
      {
        what: 'neither anchor named',
        refusal: 'VELOCITY_LIMIT_MINOR is required in production but missing.',
        env: {
          ...anchorless('MATURITY_HORIZON_CARD_MS'),
          ...anchorless('VELOCITY_LIMIT_MINOR'),
        },
        init: () => ({}),
        servable: ['development'],
      },
      {
        what: 'both anchors supplied through init.config, as a module wires them',
        env: {
          ...anchorless('MATURITY_HORIZON_CARD_MS'),
          ...anchorless('VELOCITY_LIMIT_MINOR'),
        },
        init: () => ({
          config: {
            maturityHorizonMs: { card: 604_800_000 },
            velocityLimitMinor: 5_000_000n,
          },
        }),
        servable: BOTH,
      },
    ],
  };

  const SLOTS: Record<
    string,
    Record<string, readonly Cell[]>
  > = Object.fromEntries([
    ...Object.entries(KNOB_CELLS).map(([name, cells]) => [
      name,
      { supplied: cells },
    ]),
    ...Object.entries(ENV_CELLS).map(([name, cells]) => [name, { env: cells }]),
    ...Object.entries(ANCHOR_CELLS).map(([name, cells]) => [
      name,
      { required: cells },
    ]),
  ]);

  test('every policy knob an init can supply is bounded, and it agrees with the boot', async () => {
    const { compared, booted, pinned, outcomes } = await driveCells(SLOTS);

    // The counts of what was examined, not the absence of failures.
    assert.equal(compared.length, 130, compared.join('\n'));
    assert.equal(booted.length, 65, booted.join('\n'));
    assert.equal(pinned.length, 65, pinned.join('\n'));
    // The roster itself, so a knob dropped from the table shows up in the diff rather than as a
    // smaller number nobody reads. The three anchor slots are written out rather than read back
    // off the roster that built them, since that comparison holds however few of them ran.
    assert.deepEqual(
      [...outcomes.keys()].sort(),
      [
        ...Object.keys(KNOB_CELLS),
        ...Object.keys(ENV_CELLS),
        'anchor MATURITY_HORIZON_CARD_MS',
        'anchor VELOCITY_LIMIT_MINOR',
        'anchor pair',
      ].sort(),
      'a knob Config declares was never driven',
    );
    assertBothOutcomes(outcomes);
  });

  test('a bad policy knob is a named refusal, never a raw fault on the first sale', async () => {
    const examined: string[] = [];
    for (const cells of Object.values(KNOB_CELLS)) {
      for (const cell of cells.filter((one) => one.servable.length === 0)) {
        let thrown: unknown = null;
        try {
          await openPorts({}, { logger: silentLogger(), ...cell.init() });
        } catch (error) {
          thrown = error;
        }
        assert.ok(thrown !== null, `${cell.what} opened`);
        const seen = `${cell.what} refused as ${(thrown as Error).constructor.name}: ${(thrown as Error).message}`;
        assert.equal((thrown as Error).name, 'EconomyError', seen);
        assert.equal(
          (thrown as { code?: string }).code,
          'CONFIG.INVALID',
          seen,
        );
        examined.push(cell.what);
      }
    }
    assert.equal(examined.length, 30, examined.join('\n'));
  });

  // The positive control, and the reason it is a whole sale rather than a boot: "bad knobs are
  // refused" is satisfied by refusing every knob. A fee inside the bound has to still open AND
  // still split a sale the way it says it will.
  test('a fee inside the bound opens clean and posts the split it states', async () => {
    const ports = await openPorts(
      {},
      { config: { platformFeeBps: 3_000 }, logger: silentLogger() },
    );
    assert.deepEqual(preflight({}, { config: { platformFeeBps: 3_000 } }), []);
    assert.equal(ports.config.platformFeeBps, 3_000);

    const economy = createEconomy(ports);
    await economy.submit(
      topUp({
        idempotencyKey: 'idem_fee_control',
        actor: systemActor('test'),
        userId: 'usr_fee_buyer',
        amount: toAmount('CREDIT', 5_000n),
        source: 'card',
      }),
    );
    const sale = await economy.submit(
      spend({
        idempotencyKey: 'idem_fee_sale',
        actor: userActor('usr_fee_buyer'),
        orderId: 'ord_fee_control',
        buyerId: 'usr_fee_buyer',
        sku: 'wrld_pass',
        price: toAmount('CREDIT', 1_000n),
        recipients: [{ sellerId: 'usr_fee_seller', shareBps: 10_000 }],
      }),
    );
    assert.equal(sale.status, 'committed');
    if (sale.status !== 'committed') throw new Error('unreachable');

    // 30% of 1,000 credits: 300 to the platform, 700 to the seller, stated as figures rather
    // than re-derived from the fee.
    const paid = new Map(
      sale.transaction.legs.map((leg) => [leg.account, leg.amount.minor]),
    );
    assert.equal(paid.get(earned('usr_fee_seller')), -700n);
    assert.equal(paid.get(SYSTEM.REVENUE), -300n);
    assert.equal(
      (await economy.read.balance(earned('usr_fee_seller'))).minor,
      700n,
    );
    await economy.close();
  });

  // openPorts is the door the cells drive. These are the other four a host reaches a config
  // through, and every one of them resolves the supplied bag through mergeConfig.
  test('every door that takes a config refuses the same value', () => {
    const bad = { platformFeeBps: 99_999 };
    const good = { platformFeeBps: 3_000 };
    const doors: [string, (patch: Partial<Config>) => Config][] = [
      ['defaultConfig', (patch) => defaultConfig(patch)],
      ['mergeConfig', (patch) => mergeConfig(defaultConfig(), patch)],
      ['inspectConfig', (patch) => inspectConfig({}, patch)],
      [
        'memoryPorts',
        (patch) => memoryPorts({ signingKey: 'k', config: patch }).config,
      ],
    ];
    for (const [name, open] of doors) {
      assert.throws(() => open(bad), hasCode('CONFIG.INVALID'), name);
      // And the same door still opens on the value inside the bound, so what it refused is the
      // value and not the door.
      assert.equal(open(good).platformFeeBps, 3_000, name);
    }
    assert.equal(doors.length, 4);
  });

  // An env value the resolver threw away is a warning, not an error: the deployment is servable,
  // it just runs on a default nobody chose. Unreported, 99999 silently becomes 1530.
  test('an env knob the resolver discards is reported, and blocks nothing', async () => {
    const found = preflight({ PLATFORM_FEE_BPS: '99999' }, {});
    assert.deepEqual(
      found.map((one) => [one.severity, one.code, one.path]),
      [['warning', 'config.ignored', 'PLATFORM_FEE_BPS']],
    );
    assert.match(
      found[0]!.message,
      /loadConfig ignores it and uses its default/,
    );

    const ports = await openPorts(
      { PLATFORM_FEE_BPS: '99999' },
      { logger: silentLogger() },
    );
    assert.equal(ports.config.platformFeeBps, 1530);
    await ports.store.close();
  });
});

/**
 * Every declinable slot resolves off one reading of the decline.
 *
 * `slotStates` computed it for all three, `dispatcher` used it, and the other two read the init
 * alone — so an operator who set `PAYEES_DECLINED=1` got payee verification anyway, while
 * `preflight`'s warning said "the decline wins" and `describeEnv` reported the slot `declined`.
 * Three readings agreed on a state the bag contradicted.
 */
describe('a decline flag beats a supplied port, on every declinable slot', () => {
  // The production baseline already declines all three. The decline-conflict warning is a
  // production row, so the posture is what makes the three readings comparable at all.
  const DECLINED = COMPLETE_PRODUCTION;
  const UNDECLINED = {
    ...COMPLETE_PRODUCTION,
    DISPATCHER_DECLINED: '',
    PAYEES_DECLINED: '',
    ANCHOR_DECLINED: '',
  };

  const supplied = (): PortsInit => ({
    dispatcher: (async () => {}) as Dispatcher,
    payees: { status: async () => ({ state: 'CLEARED' }) } as PayeeDirectory,
    anchor: { publish: async () => {} } as Anchor,
    logger: silentLogger(),
  });

  test('the flagged slot is absent from the bag, and the warning names it', async () => {
    const ports = await openPorts(DECLINED, supplied());
    assert.deepEqual(
      {
        dispatcher: ports.dispatcher,
        payees: ports.payees,
        anchor: ports.anchor,
      },
      { dispatcher: undefined, payees: undefined, anchor: undefined },
    );
    assert.deepEqual(
      preflight(DECLINED, supplied())
        .filter((one) => one.code === 'port.decline-conflict')
        .map((one) => one.path),
      ['dispatcher', 'payees', 'anchor'],
    );
    assert.deepEqual(
      [
        describeEnv(DECLINED, supplied()).dispatcher.kind,
        describeEnv(DECLINED, supplied()).payees,
        describeEnv(DECLINED, supplied()).anchor,
      ],
      ['declined', 'declined', 'declined'],
    );
    await ports.store.close();
  });

  test('with no flag set, the same three ports reach the bag', async () => {
    const ports = await openPorts(UNDECLINED, supplied());
    assert.deepEqual(
      [
        typeof ports.dispatcher,
        typeof ports.payees?.status,
        typeof ports.anchor?.publish,
      ],
      ['function', 'function', 'function'],
    );
    await ports.store.close();
  });
});

/**
 * `describeEnv` is the adapter reading `economy check` prints, and three of its rows resolved the
 * environment alone while `openPorts` resolves the init first. Measured: a module exporting a real
 * payout rail was reported `processor memory`, a supplied store was reported as whatever
 * `DATABASE_URL` said, and `cache: false` was reported as the redis nothing opened.
 *
 * So every row is held to the bag rather than to a second reading of the environment — the report
 * is compared with the ports `openPorts` returns from the same pair, on one host that wires all
 * six. The kinds are still written out as literals, because a comparison against the bag alone
 * would be satisfied by a report that named every slot `supplied`.
 */
describe('describeEnv reports the bag openPorts will build', () => {
  const PG = 'postgres://econ:secret@db:5432/economy';
  const REDIS = 'redis://cache:6379';
  const SQS = 'https://sqs.us-east-1.amazonaws.com/1/economy';
  const PAYOUTS = 'https://payouts.example';

  // Every knob a wired slot overrides, all set at once, so a row that quietly kept reading the
  // environment reports the knob instead of the port.
  const CONFIGURED: Record<string, string> = {
    DATABASE_URL: PG,
    REDIS_URL: REDIS,
    SQS_QUEUE_URL: SQS,
    PROCESSOR_URL: PAYOUTS,
  };

  const host = (): PortsInit => {
    const real = memoryPorts({ signingKey: 'describe-signing-key' });
    return {
      store: real.store,
      cache: {
        get: async () => null,
        set: async () => {},
        invalidate: async () => {},
      },
      dispatcher: (async () => {}) as Dispatcher,
      processor: real.processor,
      payees: { status: async () => ({ state: 'CLEARED' }) } as PayeeDirectory,
      anchor: { publish: async () => {} } as Anchor,
      logger: silentLogger(),
    };
  };

  // The rows this describe is about. The rest of the report is admitted by name with the reason it
  // is not an adapter, and the two lists are held to EnvDescription's own keys — so a seventh row
  // added to the report is examined here or argued for, never left out of both.
  const ADAPTER_ROWS = [
    'store',
    'cache',
    'dispatcher',
    'processor',
    'payees',
    'anchor',
  ] as const;

  const NOT_ADAPTERS: Readonly<Record<string, string>> = {
    production: 'the posture the report is read in, not a port',
    secrets: 'presence only, and describeSecrets already resolves the init',
    // Admitted with its defect named rather than with a reason it does not have: the row resolves
    // the init and then reads the env string raw instead of through the resolver, so
    // VELOCITY_WINDOW_MS=0 reports 0 against a bag holding 3600000. Filed as Q391.
    velocityWindowMs: 'the one policy row, and it is Q391 rather than a port',
  };

  test('the report covers every row EnvDescription publishes', () => {
    assert.deepEqual(
      Object.keys(describeEnv({})).sort(),
      [...ADAPTER_ROWS, ...Object.keys(NOT_ADAPTERS)].sort(),
    );
    assert.equal(ADAPTER_ROWS.length, 6);
  });

  test('a host that wires all six is reported wired, beside the knobs it overrides', async () => {
    const init = host();
    const described = describeEnv(CONFIGURED, init);

    // The kind is the port that will be in the bag; the url is the knob the environment still
    // names, so an operator can see the DATABASE_URL their supplied store is meant to match.
    assert.deepEqual(described.store, { kind: 'supplied', url: PG });
    assert.deepEqual(described.cache, { kind: 'supplied', url: REDIS });
    assert.deepEqual(described.dispatcher, { kind: 'in-process', url: SQS });
    assert.deepEqual(described.processor, { kind: 'supplied', url: PAYOUTS });
    assert.equal(described.payees, 'set');
    assert.equal(described.anchor, 'set');

    // And the bag from the same pair, so the report is held to what opened rather than to the
    // environment it was read from.
    const ports = await openPorts(CONFIGURED, init);
    assert.equal(ports.store, init.store);
    assert.equal(ports.cache, init.cache);
    assert.equal(ports.dispatcher, init.dispatcher);
    assert.equal(ports.processor, init.processor);
    assert.equal(ports.payees, init.payees);
    assert.equal(ports.anchor, init.anchor);
    await ports.store.close();
  });

  test('a declined cache is not the redis the environment names', async () => {
    const init = { cache: false as const, logger: silentLogger() };
    assert.deepEqual(describeEnv({ REDIS_URL: REDIS }, init).cache, {
      kind: 'declined',
      url: REDIS,
    });
    const ports = await openPorts({ REDIS_URL: REDIS }, init);
    assert.equal(ports.cache, undefined);
    await ports.store.close();
  });

  // The positive control: with nothing supplied, every row still reports the environment's own
  // selection. Without it "the report names the init" is satisfiable by a report that never reads
  // the environment again.
  test('with nothing wired, the same environment reports the selection it names', () => {
    const described = describeEnv(CONFIGURED);
    assert.deepEqual(described.store, { kind: 'postgres', url: PG });
    assert.deepEqual(described.cache, { kind: 'redis', url: REDIS });
    assert.deepEqual(described.dispatcher, { kind: 'sqs', url: SQS });
    assert.deepEqual(described.processor, { kind: 'http', url: PAYOUTS });
    assert.equal(described.payees, 'missing');
    assert.equal(described.anchor, 'missing');
  });
});

describe('the anchor rides composition into the checkpoint seal', () => {
  test('an anchor in the init reaches the ports bag', async () => {
    const anchor: Anchor = { publish: async () => {} };
    const ports = await openPorts({}, { anchor, logger: silentLogger() });
    assert.equal(ports.anchor, anchor);
    await ports.store.close();
  });

  test('a sealed checkpoint reaches the wired anchor', async () => {
    const published: Checkpoint[] = [];
    const anchor: Anchor = {
      publish: async (checkpoint) => {
        published.push(checkpoint);
      },
    };
    const ports = await openPorts({}, { anchor, logger: silentLogger() });
    const economy = createEconomy(ports);
    await economy.submit(
      topUp({
        idempotencyKey: 'idem_anchor',
        actor: systemActor('test'),
        userId: 'usr_anchor',
        amount: toAmount('CREDIT', 100n),
        source: 'card',
      }),
    );
    const worker = createWorker(ports, economy);
    const run = await worker.sweep({ now: 1_000, limit: 10 });

    assert.equal(run.batch.checkpoint.ok, true);
    assert.equal(published.length, 1);
    await economy.close();
  });
});

// The backends are their own packages, so a configured environment with no port supplied fails
// at boot with the package to install and the line to add. The message is the only fix
// instruction a developer gets, and it is read by two audiences — a module file exports the
// port through the @pwngh/economy door it already has, and a lab host installs the engine
// package and passes it to openPorts — so both forms are held to naming a package that exists
// and an export it really has. A rename on either side breaks this rather than the developer's
// afternoon.
describe('a configured backend with no package names its fix exactly', () => {
  const cases = [
    {
      env: { DATABASE_URL: 'postgres://econ:secret@db:5432/economy' },
      pkg: '@pwngh/economy-postgres',
      door: '@pwngh/economy/postgres',
      factory: 'postgres',
      slot: 'store',
    },
    {
      env: { DATABASE_URL: 'mysql://econ:secret@db:3306/economy' },
      pkg: '@pwngh/economy-mysql',
      door: '@pwngh/economy/mysql',
      factory: 'mysql',
      slot: 'store',
    },
    {
      env: { REDIS_URL: 'redis://cache:6379' },
      pkg: '@pwngh/economy-redis',
      door: '@pwngh/economy/redis',
      factory: 'redisCache',
      slot: 'cache',
    },
    {
      env: { SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/economy' },
      pkg: '@pwngh/economy-sqs',
      door: '@pwngh/economy/sqs',
      factory: 'sqs',
      slot: 'dispatcher',
    },
  ];

  for (const { env, pkg, door, factory, slot } of cases) {
    test(`${pkg} is named, and it really exports ${factory}`, async () => {
      let thrown: unknown = null;
      try {
        await openPorts(env, { logger: silentLogger() });
      } catch (error) {
        thrown = error;
      }
      assert.notEqual(thrown, null, `${slot} opened without its package`);
      const message = (thrown as Error).message;
      assert.equal((thrown as { code?: string }).code, 'CONFIG.INVALID');

      // The module-file form: the door import and an `export const ports`.
      assert.match(
        message,
        new RegExp(`import \\{ ${factory} \\} from '${door}'`),
      );
      assert.match(message, /export const ports/);

      // The lab-host form: the engine package and an `openPorts` call.
      assert.match(message, new RegExp(`Install ${pkg} `));
      assert.match(
        message,
        new RegExp(`import \\{ ${factory} \\} from '${pkg}'`),
      );
      assert.match(message, /const ports = await openPorts\(process\.env/);
      assert.match(message, new RegExp(`${slot}: await ${factory}\\(`));

      // Both named exports have to be real, or a fix instruction is a dead end.
      for (const specifier of [pkg, door]) {
        const module = (await import(specifier)) as Record<string, unknown>;
        assert.equal(
          typeof module[factory],
          'function',
          `${specifier} does not export ${factory}()`,
        );
      }
    });
  }

  // Selection itself survives: preflight and describeEnv still report what the environment asked
  // for, so an operator's config check is unchanged by the split.
  test('describeEnv still reports the engine the environment names', async () => {
    const { describeEnv } = await import('#src/index.ts');
    const described = describeEnv({
      DATABASE_URL: 'postgres://econ:secret@db:5432/economy',
      REDIS_URL: 'redis://cache:6379',
    });
    assert.equal(described.store.kind, 'postgres');
    assert.equal(described.cache.kind, 'redis');
  });
});
