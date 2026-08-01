/**
 * @pwngh/economy-cli
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_IP_HEADER } from '@pwngh/economy-lab/server';
import {
  PortInUse,
  detectRuntime,
  isPortInUse,
  platformOwner,
  serveFetch,
} from '../src/lib/platform.js';
import type { Runtime, RuntimeGlobals } from '../src/lib/platform.js';

test('detectRuntime: Bun and Deno globals win in that order; bare globals mean node', () => {
  assert.equal(detectRuntime({}), 'node');
  assert.equal(detectRuntime({ Bun: {} as never }), 'bun');
  assert.equal(detectRuntime({ Deno: {} as never }), 'deno');
  assert.equal(detectRuntime({ Bun: {} as never, Deno: {} as never }), 'bun');
});

test('platformOwner: wrangler config and Next markers detected from files, empty dir owns nothing', () => {
  const base = mkdtempSync(join(tmpdir(), 'economy-platform-'));
  const cf = join(base, 'cf');
  const next = join(base, 'next');
  const nextDep = join(base, 'next-dep');
  const empty = join(base, 'empty');
  for (const d of [cf, next, nextDep, empty]) mkdirSync(d, { recursive: true });
  writeFileSync(join(cf, 'wrangler.jsonc'), '{}');
  writeFileSync(join(next, 'next.config.mjs'), 'export default {};');
  writeFileSync(
    join(nextDep, 'package.json'),
    JSON.stringify({ dependencies: { next: '^15.0.0' } }),
  );
  assert.deepEqual(platformOwner(cf), {
    platform: 'a Cloudflare Worker',
    command: 'wrangler dev',
  });
  assert.deepEqual(platformOwner(next), {
    platform: 'a Next.js app',
    command: 'next dev',
  });
  assert.deepEqual(platformOwner(nextDep), {
    platform: 'a Next.js app',
    command: 'next dev',
  });
  assert.equal(platformOwner(empty), null);
});

test('platformOwner: a wrangler file wins over a Next marker in the same directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'economy-platform-both-'));
  writeFileSync(join(base, 'wrangler.toml'), 'name = "shop"\n');
  writeFileSync(join(base, 'next.config.mjs'), 'export default {};');
  assert.deepEqual(platformOwner(base), {
    platform: 'a Cloudflare Worker',
    command: 'wrangler dev',
  });
});

test('serveFetch bun leg: a client-supplied client-ip header is stripped when the runtime cannot resolve the peer', async () => {
  let seen: Request | null = null;
  let captured: {
    fetch: (r: Request, s: unknown) => Promise<Response>;
  } | null = null;
  const g: RuntimeGlobals = {
    Bun: {
      serve(options) {
        captured = options as never;
        return { port: options.port, stop: () => {} };
      },
    },
  };
  await serveFetch(
    'bun',
    async (request) => {
      seen = request;
      return new Response('ok');
    },
    3000,
    undefined,
    g,
  );
  // The client sends its own loopback stamp; requestIP yields nothing (peer unresolved).
  const spoofed = new Request('http://t/v1/wallet', {
    headers: { [CLIENT_IP_HEADER]: '127.0.0.1' },
  });
  await captured!.fetch(spoofed, { requestIP: () => null });
  assert.equal(
    seen!.headers.get(CLIENT_IP_HEADER),
    null,
    'the client never speaks for its own address',
  );
});

test('serveFetch deno leg: a client-supplied client-ip header is stripped when remoteAddr is absent', async () => {
  let seen: Request | null = null;
  const g: RuntimeGlobals = {
    Deno: {
      serve(_options, handler) {
        void handler(
          new Request('http://t/v1/wallet', {
            headers: { [CLIENT_IP_HEADER]: '10.0.0.9' },
          }),
          {},
        );
        return {
          addr: { port: 8765 },
          finished: Promise.resolve(),
          shutdown: async () => {},
        };
      },
    },
  };
  await serveFetch(
    'deno',
    async (request) => {
      seen = request;
      return new Response('ok');
    },
    0,
    undefined,
    g,
  );
  assert.equal(
    seen!.headers.get(CLIENT_IP_HEADER),
    null,
    'the client never speaks for its own address',
  );
});

test('serveFetch bun leg: Bun.serve gets the port and a fetch that stamps the client address', async () => {
  let seen: Request | null = null;
  const handler = async (request: Request) => {
    seen = request;
    return new Response('ok');
  };
  let captured: {
    port: number;
    fetch: (r: Request, s: unknown) => Promise<Response>;
  } | null = null;
  const g: RuntimeGlobals = {
    Bun: {
      serve(options) {
        captured = options as never;
        return {
          port: options.port === 0 ? 4321 : options.port,
          stop: () => {},
        };
      },
    },
  };
  const served = await serveFetch('bun', handler, 0, '127.0.0.1', g);
  assert.equal(served.port, 4321);
  await captured!.fetch(new Request('http://t/healthz'), {
    requestIP: () => ({ address: '127.0.0.1' }),
  });
  assert.equal(seen!.headers.get(CLIENT_IP_HEADER), '127.0.0.1');
  await served.close();
});

test('serveFetch deno leg: Deno.serve gets the handler and reports the address it bound', async () => {
  let seen: Request | null = null;
  const g: RuntimeGlobals = {
    Deno: {
      serve(_options, handler) {
        void handler(new Request('http://t/healthz'), {
          remoteAddr: { hostname: '127.0.0.1' },
        });
        return {
          addr: { port: 8765 },
          finished: Promise.resolve(),
          shutdown: async () => {},
        };
      },
    },
  };
  const served = await serveFetch(
    'deno',
    async (request) => {
      seen = request;
      return new Response('ok');
    },
    0,
    undefined,
    g,
  );
  assert.equal(served.port, 8765);
  assert.equal(seen!.headers.get(CLIENT_IP_HEADER), '127.0.0.1');
});

// Deno's own AddrInUse: `class AddrInUse extends Error` with `this.name = "AddrInUse"` and
// nothing else — no `code`, no `port` (deno/runtime/js/01_errors.js).
class DenoAddrInUse extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddrInUse';
  }
}

/** A runtime whose serve() refuses the bind, in that runtime's own shape. */
interface BindLeg {
  readonly runtime: Exclude<Runtime, 'node'>;
  /** The taken-port throw this runtime raises. Deno's carries neither a code nor the port. */
  taken(): unknown;
  refusing(thrown: unknown): RuntimeGlobals;
}

const BIND_LEGS: readonly BindLeg[] = [
  {
    runtime: 'bun',
    // Bun raises Node's shape but not Node's fields: `code` is there, the port is only in the text.
    taken: () =>
      Object.assign(
        new Error('EADDRINUSE: Failed to start server. Is port 3000 in use?'),
        { code: 'EADDRINUSE', syscall: 'listen' },
      ),
    refusing: (thrown) => ({
      Bun: {
        serve() {
          throw thrown;
        },
      },
    }),
  },
  {
    runtime: 'deno',
    taken: () => new DenoAddrInUse('Address already in use (os error 48)'),
    refusing: (thrown) => ({
      Deno: {
        serve() {
          throw thrown;
        },
      },
    }),
  },
];

for (const leg of BIND_LEGS) {
  test(`serveFetch ${leg.runtime} leg: a taken port refuses in the one shape the CLI reads`, async () => {
    const thrown = leg.taken();
    const refused = await serveFetch(
      leg.runtime,
      answers,
      3000,
      undefined,
      leg.refusing(thrown),
    ).then(
      () => null,
      (error: unknown) => error as { code?: unknown; port?: unknown },
    );
    assert.ok(
      refused,
      'the bind resolved a server on a port nobody could bind',
    );
    assert.equal(
      refused.code,
      'EADDRINUSE',
      `the ${leg.runtime} bind failure kept its own shape, so the CLI's refusal never fires`,
    );
    assert.equal(
      refused.port,
      3000,
      'the refusal cannot name the port it asked for',
    );
    assert.equal(
      (refused as { cause?: unknown }).cause,
      thrown,
      "the runtime's own error was dropped rather than carried",
    );
  });

  test(`serveFetch ${leg.runtime} leg: a bind failure that is not a taken port passes through untouched`, async () => {
    // The control. Without it "classified as a taken port" is satisfied by classifying everything,
    // and `economy dev` would blame a busy port for a permission the host does not have.
    const thrown = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const refused = await serveFetch(
      leg.runtime,
      answers,
      80,
      undefined,
      leg.refusing(thrown),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.equal(refused, thrown);
  });
}

test('serveFetch deno leg: the taken port is read from the error class, not only from its name', async () => {
  // The deno leg above states no `errors` bag, so it is classified by the `name` Deno's class
  // sets. This is the other half: an AddrInUse whose name was overwritten, which only the class
  // itself identifies.
  const thrown = Object.assign(new DenoAddrInUse('address in use'), {
    name: 'Error',
  });
  const refused = await serveFetch('deno', answers, 8787, undefined, {
    Deno: {
      serve() {
        throw thrown;
      },
      errors: { AddrInUse: DenoAddrInUse },
    },
  } as RuntimeGlobals).then(
    () => null,
    (error: unknown) => error as { code?: unknown; port?: unknown },
  );
  assert.equal(refused?.code, 'EADDRINUSE');
  assert.equal(refused?.port, 8787);
});

test('isPortInUse accepts the taken-port shape and nothing else', () => {
  assert.equal(isPortInUse(new PortInUse(3000, { cause: null })), true);
  assert.equal(
    isPortInUse(Object.assign(new Error('x'), { code: 'EADDRINUSE' })),
    true,
    "Node's own bind failure is the shape this names",
  );
  assert.equal(
    isPortInUse(Object.assign(new Error('x'), { code: 'EACCES' })),
    false,
  );
  assert.equal(isPortInUse(new DenoAddrInUse('x')), false);
  assert.equal(isPortInUse('EADDRINUSE'), false);
  assert.equal(isPortInUse(null), false);
});

/**
 * A runtime server that can hold answers open, so a shutdown is judged by what it did to them:
 * `open` are in flight, `drained` finished on their own, `severed` were terminated by the cut.
 * `drains` and `cuts` count which shutdown each leg reached for.
 */
function conversations() {
  const state = { open: 0, drained: 0, severed: 0, drains: 0, cuts: 0 };
  let quiet: (() => void) | null = null;
  let ended: () => void;
  const finished = new Promise<void>((done) => {
    ended = done;
  });
  const down = () => {
    quiet?.();
    ended();
  };
  return {
    state,
    finished,
    /** One request the server is now answering; the returned call is the client's answer arriving. */
    begin(): () => void {
      state.open += 1;
      return () => {
        state.open -= 1;
        state.drained += 1;
        if (state.open === 0) down();
      };
    },
    /** Bun's `stop()` and Deno's `shutdown()`: stop accepting, settle when nothing is in flight. */
    drain(): Promise<void> {
      state.drains += 1;
      if (state.open === 0) {
        down();
        return Promise.resolve();
      }
      return new Promise<void>((settled) => {
        quiet = settled;
      });
    },
    /** Bun's `stop(true)` and Deno's aborted signal: terminate whatever is still in flight. */
    cut(): Promise<void> {
      state.cuts += 1;
      state.severed += state.open;
      state.open = 0;
      down();
      return Promise.resolve();
    },
  };
}

type Conversations = ReturnType<typeof conversations>;

interface Leg {
  readonly runtime: Exclude<Runtime, 'node'>;
  globals(c: Conversations): RuntimeGlobals;
}

// One contract, two runtimes: the same three assertions run against both legs, because the whole
// point of this shutdown is that a host cannot tell which runtime answered it.
const LEGS: readonly Leg[] = [
  {
    runtime: 'bun',
    globals: (c) => ({
      Bun: {
        serve: (options) => ({
          port: options.port,
          stop: (closeActiveConnections) =>
            closeActiveConnections ? c.cut() : c.drain(),
        }),
      },
    }),
  },
  {
    runtime: 'deno',
    globals: (c) => ({
      Deno: {
        serve: (options) => {
          options.signal?.addEventListener('abort', () => void c.cut());
          return {
            addr: { port: options.port },
            finished: c.finished,
            shutdown: () => c.drain(),
          };
        },
      },
    }),
  },
];

// Every wait here is bounded, because the defect under test is a close that never returns: a
// shutdown that wedges must fail with the assertion below rather than run out the file's clock.
const CEILING_MS = 3_000;

async function settles(closing: Promise<void>, label: string): Promise<number> {
  const at = Date.now();
  let ceiling: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    closing.then(() => 'settled' as const),
    new Promise<'wedged'>((fire) => {
      ceiling = setTimeout(() => fire('wedged'), CEILING_MS);
    }),
  ]);
  clearTimeout(ceiling);
  assert.equal(
    outcome,
    'settled',
    `${label} did not settle in ${CEILING_MS} ms`,
  );
  return Date.now() - at;
}

const answers = async () => new Response('ok');

for (const leg of LEGS) {
  test(`serveFetch ${leg.runtime} leg: close(drain) lets an answer in flight finish`, async () => {
    const c = conversations();
    const served = await serveFetch(
      leg.runtime,
      answers,
      0,
      undefined,
      leg.globals(c),
    );
    const answered = c.begin();
    setTimeout(answered, 25);
    assert.equal(
      c.state.open,
      1,
      'nothing was in flight, so a drain proves nothing',
    );
    const took = await settles(served.close(2_000), 'close(2_000)');
    assert.deepEqual(
      {
        drained: c.state.drained,
        severed: c.state.severed,
        cuts: c.state.cuts,
      },
      { drained: 1, severed: 0, cuts: 0 },
      'the answer in flight was cut rather than drained',
    );
    assert.ok(
      took < 1_000,
      `close waited out the 2,000 ms budget (${took} ms)`,
    );
  });

  test(`serveFetch ${leg.runtime} leg: close(drain) cuts what the drain did not finish`, async () => {
    const c = conversations();
    const served = await serveFetch(
      leg.runtime,
      answers,
      0,
      undefined,
      leg.globals(c),
    );
    c.begin();
    assert.equal(
      c.state.open,
      1,
      'nothing was in flight, so a cut proves nothing',
    );
    const took = await settles(served.close(250), 'close(250)');
    assert.deepEqual(
      { drained: c.state.drained, severed: c.state.severed },
      { drained: 0, severed: 1 },
      'the request nobody answered was left holding the listener',
    );
    assert.deepEqual(
      [c.state.drains, c.state.cuts],
      [1, 1],
      'the drain was skipped, or the cut never came',
    );
    assert.ok(
      took >= 250,
      `close cut at ${took} ms instead of draining for the 250 ms budget first`,
    );
  });

  test(`serveFetch ${leg.runtime} leg: close() with no drain cuts at once`, async () => {
    const c = conversations();
    const served = await serveFetch(
      leg.runtime,
      answers,
      0,
      undefined,
      leg.globals(c),
    );
    c.begin();
    assert.equal(
      c.state.open,
      1,
      'nothing was in flight, so a cut proves nothing',
    );
    await settles(served.close(), 'close()');
    assert.deepEqual(
      {
        drained: c.state.drained,
        severed: c.state.severed,
        drains: c.state.drains,
      },
      { drained: 0, severed: 1, drains: 0 },
      'the default drained instead of cutting',
    );
  });
}
