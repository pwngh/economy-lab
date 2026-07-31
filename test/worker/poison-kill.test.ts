/// <reference types="node" />
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
 * The poison event that takes the worker down with it.
 *
 * Every other retry test in this tree fails a delivery by throwing, and a throw is a fault the
 * worker survives: it catches the throw and writes the attempt down afterwards. This probe covers
 * the fault that leaves nothing to catch. It spawns a real worker process, waits until the delivery has genuinely
 * started, and SIGKILLs it. Nothing in that process runs again, so the only accounting that
 * survives is what was already committed before the work began.
 *
 * The store lives here, in the test process, and the worker reaches it over a real socket
 * ({@link createStoreServer} served by {@link serveNode}), so killing the worker leaves the rows
 * intact and readable. The assertion is the count: after each kill the row must show exactly that
 * many attempts, and once the budget is spent the next sweep must give up on it without delivering
 * again. A row that merely ends up dead-lettered is not enough — it has to walk there one counted
 * attempt at a time, and the events behind it have to be free once it does.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { serveNode } from '#src/adapters/http-node.ts';
import { createStoreServer } from '#src/adapters/http.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { relayOutbox } from '#src/worker/relay.ts';
import { drainInbox } from '#src/worker/inbox.ts';
import { createEconomy } from '#src/economy.ts';
import { toAmount } from '#src/money.ts';
import { spendable } from '#src/accounts.ts';
import { ATTEMPTS_ABANDONED } from '#src/ports.ts';
import { makePorts, testConfig } from '#test/support/capabilities.ts';

import type { NodeServer } from '#src/adapters/http-node.ts';
import type { Operation } from '#src/contract.ts';
import type {
  Dispatcher,
  EconomyEvent,
  InboxMessage,
  Store,
} from '#src/ports.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD = fileURLToPath(
  new URL('../support/kill-worker.ts', import.meta.url),
);

// Three is enough to watch the count climb and still spawn only four processes.
const CAP = 3;

// The spawned workers reach the store over loopback, so nothing here is on a routable address.
const HOST = { host: '127.0.0.1' } as const;

// How long a spawned worker gets to reach the work it can never finish. It is a fresh node process
// against a store on localhost, so it prints within a second; past this it is a worker that started
// and never announced, which without a ceiling is a poll that runs for as long as the run does.
const READY_BOUND_MS = 20_000;

function event(id: string): EconomyEvent {
  return {
    id: `evt_${id}`,
    type: 'economy.sale.completed',
    version: 1,
    occurredAt: 0,
    subject: 'usr_buyer',
    data: {},
    audience: 'internal',
  };
}

// One pending inbox row carrying a top-up for its own user, so the ledger says whether the apply
// ever landed.
function inboxRow(id: string): InboxMessage {
  return {
    id,
    key: `key_${id}`,
    operation: {
      kind: 'topUp',
      idempotencyKey: `key_${id}`,
      actor: { kind: 'system', service: 'webhook:billing' },
      userId: `usr_${id}`,
      amount: toAmount('CREDIT', 1_000n),
      source: 'card',
    } as Operation,
    status: 'pending',
    attempts: 0,
    receivedAt: 0,
    reason: null,
  };
}

// Puts the store's fetch-shaped server on a real port so another process can reach it. A held
// request is answered by a promise that never settles, which is how a worker is parked inside a
// store call; `close()` cuts those connections rather than waiting on them.
async function serveStore(
  store: Store,
  hold: (path: string) => boolean = () => false,
): Promise<{ live: NodeServer; held: string[] }> {
  const handler = createStoreServer(store);
  const held: string[] = [];
  const live = await serveNode(async (request) => {
    const { pathname, search } = new URL(request.url);
    const path = `${pathname}${search}`;
    if (hold(path)) {
      held.push(path);
      return new Promise<Response>(() => {});
    }
    return handler(request);
  }, HOST);
  return { live, held };
}

// Runs one worker process and kills it the instant `ready` turns true, which is the instant the
// work it can never finish has started. Returns nothing: the evidence is what the store kept.
async function killOneWorker(input: {
  mode: 'relay' | 'inbox';
  baseUrl: string;
  ready: (stdout: string) => boolean;
}): Promise<void> {
  const env = { ...process.env };
  // node --test leaks this to children, and a child that inherits it reports its own outcome
  // wrongly. It must be deleted, never blanked.
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    [CHILD, input.mode, input.baseUrl, String(CAP)],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const started = new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      if (input.ready(stdout)) {
        clearInterval(poll);
        clearTimeout(ceiling);
        resolve();
      }
    }, 5);
    const ceiling = setTimeout(() => {
      clearInterval(poll);
      child.kill('SIGKILL');
      reject(
        new Error(
          `the worker never announced its work within ${READY_BOUND_MS}ms: ` +
            `${stdout || '(no stdout)'} / ${stderr || '(no stderr)'}`,
        ),
      );
    }, READY_BOUND_MS);
    child.once('exit', (code, signal) => {
      clearInterval(poll);
      clearTimeout(ceiling);
      reject(
        new Error(
          `the worker exited (code ${String(code)}, signal ${String(signal)}) ` +
            `before it started work: ${stderr || '(no stderr)'}`,
        ),
      );
    });
  });

  await started;
  child.kill('SIGKILL');
  const [code, signal] = (await once(child, 'exit')) as [
    number | null,
    string | null,
  ];
  assert.equal(
    signal,
    'SIGKILL',
    `the worker must die by signal, not exit (code ${String(code)}): ` +
      (stderr || '(no stderr)'),
  );
}

describe('a poison event that kills the worker', () => {
  test('counts every delivery it started, then gives up without delivering again', async () => {
    const store = memoryStore();
    await store.transaction((unit) =>
      unit.outbox.enqueue({
        id: 'obx_poison',
        event: event('poison'),
        status: 'pending',
        attempts: 0,
        reason: null,
        correlationId: null,
      }),
    );
    await store.transaction((unit) =>
      unit.outbox.enqueue({
        id: 'obx_behind',
        event: event('behind'),
        status: 'pending',
        attempts: 0,
        reason: null,
        correlationId: null,
      }),
    );
    const { live } = await serveStore(store);

    try {
      for (let killed = 1; killed <= CAP; killed += 1) {
        await killOneWorker({
          mode: 'relay',
          baseUrl: live.url,
          ready: (out) => out.includes('DISPATCHING'),
        });
        const claimed = await store.outbox.claimBatch(10);
        const poison = claimed.find((row) => row.id === 'obx_poison');
        assert.equal(
          poison?.attempts,
          killed,
          `after ${killed} deliveries that killed the worker the row must count ${killed}`,
        );
        assert.equal(poison?.status, 'pending');
        // The row claimed alongside it was never dispatched, so it must not have been charged for
        // the batch the poison row killed.
        assert.equal(
          claimed.find((row) => row.id === 'obx_behind')?.attempts,
          0,
          'a row claimed in the same batch but never dispatched must count nothing',
        );
      }

      // The budget is spent, so this sweep must not start a fourth delivery.
      const delivered: string[] = [];
      const dispatcher: Dispatcher = async (e) => {
        delivered.push(e.id);
      };
      const summary = await relayOutbox(
        store,
        makePorts(store, {
          config: { ...testConfig(), maxOutboxAttempts: CAP },
        }),
        { dispatcher, limit: 10 },
      );

      assert.deepEqual(summary.deadLettered, [
        { id: 'obx_poison', reason: ATTEMPTS_ABANDONED },
      ]);
      assert.deepEqual(
        delivered,
        ['evt_behind'],
        'the poison row must not be delivered a fourth time, and the row behind it must go out',
      );
      assert.deepEqual(summary.relayed, ['obx_behind']);
      assert.deepEqual(await store.outbox.claimBatch(10), []);
    } finally {
      await live.close();
      await store.close();
    }
  });

  test('counts every apply it started, then gives up without applying again', async () => {
    const store = memoryStore();
    await store.transaction(async (unit) => {
      await unit.inbox.enqueueInbound(inboxRow('ibx_poison'));
      await unit.inbox.enqueueInbound(inboxRow('ibx_behind'));
    });
    // The apply is parked in the store rather than in a dispatcher: every call the drain's own
    // bookkeeping makes is served, and the first call the submit makes is never answered. The
    // worker is then hung inside the apply with its attempt already counted.
    const { live, held } = await serveStore(
      store,
      (path) =>
        !path.includes('inbox/claimInbound') &&
        !path.includes('inbox/bumpAttempt'),
    );

    try {
      for (let killed = 1; killed <= CAP; killed += 1) {
        const parked = held.length;
        await killOneWorker({
          mode: 'inbox',
          baseUrl: live.url,
          ready: () => held.length > parked,
        });
        const claimed = await store.inbox.claimInbound({ now: 0, limit: 10 });
        const poison = claimed.find((row) => row.id === 'ibx_poison');
        assert.equal(
          poison?.attempts,
          killed,
          `after ${killed} applies that killed the worker the row must count ${killed}`,
        );
        assert.equal(poison?.status, 'pending');
        assert.equal(
          claimed.find((row) => row.id === 'ibx_behind')?.attempts,
          0,
          'a row claimed in the same batch but never applied must count nothing',
        );
      }

      const ports = makePorts(store, {
        config: { ...testConfig(), maxInboxAttempts: CAP },
      });
      const summary = await drainInbox(store, ports, {
        economy: createEconomy(ports),
        now: 0,
        limit: 10,
      });

      assert.deepEqual(summary.deadLettered, [
        { id: 'ibx_poison', reason: ATTEMPTS_ABANDONED },
      ]);
      assert.deepEqual(
        summary.applied,
        ['ibx_behind'],
        'the row behind the poison one must apply once the budget is spent',
      );
      assert.deepEqual(
        await store.inbox.claimInbound({ now: 0, limit: 10 }),
        [],
      );
      // The poison operation never posted: its every apply died before the submit answered.
      assert.equal(
        (await store.ledger.balance(spendable('usr_ibx_poison'))).minor,
        0n,
      );
    } finally {
      await live.close();
      await store.close();
    }
  });
});
