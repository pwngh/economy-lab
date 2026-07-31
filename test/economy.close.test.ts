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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import '#test/support/dist-guard.ts';

import { createEconomy } from '#src/economy.ts';
import { memoryPorts } from '#src/index.ts';
import { mysqlStore } from '@pwngh/economy-mysql';

import type { MysqlPool } from '@pwngh/economy-mysql';
import type {
  Anchor,
  Cache,
  Dispatcher,
  PayeeDirectory,
  Ports,
  Scheduler,
} from '#src/ports.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The script the hang proof runs in its own process. A listening socket is a real handle: the
// event loop stays alive until something closes it, so the process only exits if close() reached
// the cache.
const HANG_SCRIPT = `
import { createServer } from 'node:net';
import { createEconomy } from ${JSON.stringify(join(ROOT, 'src/economy.ts'))};
import { memoryPorts } from ${JSON.stringify(join(ROOT, 'src/index.ts'))};

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const cache = {
  get: async () => null,
  set: async () => {},
  invalidate: async () => {},
  close: async () => {
    await new Promise((resolve) => server.close(() => resolve()));
  },
};

const economy = createEconomy({ ...memoryPorts({ signingKey: 'k' }), cache });
await economy.close();
console.log('CLOSED');
`;

function runScript(source: string, timeoutMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'economy-close-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const file = join(dir, 'run.mjs');
    writeFileSync(file, source);
    const env = { ...process.env };
    // node --test leaks this to children, and an inherited value hides a child's real verdict.
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [file], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('economy.close releases the ports that hold resources', () => {
  test('a script whose cache holds an open socket exits instead of hanging', () => {
    const result = runScript(HANG_SCRIPT, 10_000);

    assert.equal(result.stderr, '', 'the script must not fault');
    assert.match(result.stdout, /CLOSED/, 'close() must have returned');
    // A killed process reports its signal here. The whole proof is that this is null.
    assert.equal(
      result.signal,
      null,
      'the process hung past the timeout and had to be killed',
    );
    assert.equal(result.status, 0);
  });
});

type Counts = {
  store: number;
  cache: number;
  dispatcher: number;
  payees: number;
  scheduler: number;
  anchor: number;
};

// One counter per port, so a test can assert how many of them closed rather than only that
// nothing threw.
function closingPorts(): { ports: Ports; counts: Counts } {
  const counts: Counts = {
    store: 0,
    cache: 0,
    dispatcher: 0,
    payees: 0,
    scheduler: 0,
    anchor: 0,
  };
  const base = memoryPorts({ signingKey: 'close-test' });
  const cache: Cache = {
    get: async () => null,
    set: async () => {},
    invalidate: async () => {},
    close: async () => {
      counts.cache += 1;
    },
  };
  const dispatcher: Dispatcher = Object.assign(async () => {}, {
    close: async () => {
      counts.dispatcher += 1;
    },
  });
  const payees: PayeeDirectory = {
    status: async () => ({ state: 'CLEARED' as const }),
    close: async () => {
      counts.payees += 1;
    },
  };
  const scheduler: Scheduler = {
    every: () => () => {},
    close: async () => {
      counts.scheduler += 1;
    },
  };
  const anchor: Anchor = {
    publish: async () => {},
    close: async () => {
      counts.anchor += 1;
    },
  };
  const ports: Ports = {
    ...base,
    store: {
      ...base.store,
      close: async () => {
        counts.store += 1;
      },
    },
    cache,
    dispatcher,
    payees,
    scheduler,
    anchor,
  };
  return { ports, counts };
}

describe('economy.close settles every port', () => {
  test('closes the store and all five optional ports', async () => {
    const rig = closingPorts();

    await createEconomy(rig.ports).close();

    // The count is the assertion: six ports declared close, six were closed exactly once.
    assert.deepEqual(rig.counts, {
      store: 1,
      cache: 1,
      dispatcher: 1,
      payees: 1,
      scheduler: 1,
      anchor: 1,
    });
    assert.equal(Object.values(rig.counts).filter((n) => n === 1).length, 6);
  });

  test('one port failing does not skip the others', async () => {
    const rig = closingPorts();
    const ports: Ports = {
      ...rig.ports,
      cache: {
        ...rig.ports.cache!,
        close: async () => {
          throw new Error('redis refused to quit');
        },
      },
    };

    const error = (await createEconomy(ports)
      .close()
      .then(
        () => null,
        (caught: unknown) => caught,
      )) as { code?: string; detail?: { ports?: unknown } } | null;

    assert.ok(error, 'the failure must surface, not be swallowed');
    assert.equal(error.code, 'PROVIDER.FAILURE');
    assert.deepEqual(error.detail?.ports, ['cache']);
    assert.equal(rig.counts.cache, 0);
    // The other five still closed: one refusal must not strand five connections.
    assert.equal(
      rig.counts.store +
        rig.counts.dispatcher +
        rig.counts.payees +
        rig.counts.scheduler +
        rig.counts.anchor,
      5,
    );
  });

  test('closing twice closes each port once', async () => {
    const rig = closingPorts();
    const economy = createEconomy(rig.ports);

    await economy.close();
    await economy.close();
    await economy.close();

    assert.deepEqual(rig.counts, {
      store: 1,
      cache: 1,
      dispatcher: 1,
      payees: 1,
      scheduler: 1,
      anchor: 1,
    });
  });

  // Why the SQL stores answer close() on a caller-supplied pool with a no-op rather than a throw:
  // this path settles every port and reports a refusal as PROVIDER.FAILURE, so a throw would
  // fail a legitimate shutdown over a pool the host was always going to end itself.
  test('a SQL store over a caller-supplied pool closes without ending it', async () => {
    let ends = 0;
    const pool: MysqlPool = {
      query: () => Promise.resolve([[], undefined] as [unknown, unknown]),
      getConnection: () => Promise.reject(new Error('unused')),
      end: () => {
        ends += 1;
        return Promise.resolve();
      },
    };
    const ports: Ports = {
      ...memoryPorts({ signingKey: 'close-test' }),
      store: mysqlStore({ pool }),
    };

    await createEconomy(ports).close();

    assert.equal(ends, 0);
  });

  test('a port with no close is left alone', async () => {
    const base = memoryPorts({ signingKey: 'close-test' });
    let stores = 0;
    const ports: Ports = {
      ...base,
      store: {
        ...base.store,
        close: async () => {
          stores += 1;
        },
      },
      cache: {
        get: async () => null,
        set: async () => {},
        invalidate: async () => {},
      },
      scheduler: { every: () => () => {} },
    };

    await createEconomy(ports).close();

    assert.equal(stores, 1);
  });
});
