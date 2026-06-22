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

// This is the one place that assembles the whole app and runs it. It reads the environment, picks
// concrete implementations of each external dependency (the database/store, the cache, the job
// dispatcher), and hands them to the builders `compose`/`composeWorker` (src/index.ts), which return
// a ready-to-use economy. The rest of the code never touches the environment — all of that happens
// here, once. Three modes selected by the first command-line argument:
//
//   scripts/main.ts serve   # HTTP API on $PORT (default 3000); store/cache/dispatcher come from env
//   scripts/main.ts dev     # same API, forced to in-memory with dev secrets — no infra, `npm run dev`
//   scripts/main.ts worker  # background loop that runs the periodic maintenance sweep every
//                            # $WORKER_INTERVAL_MS
//
// `serve`/`dev` run the request handler from src/server.ts. That handler is written against the web
// standard Request/Response types: Bun and Deno can run it as-is, and on Node we translate node:http
// requests into web Requests first (`bridge`, below). That Node translation is the reason this entry
// file lives in scripts/ — the rest of src/ avoids Node-specific APIs so it can run on any runtime.
//
// Three external services have no safe default value — the request signer, the CREDIT-to-USD
// exchange rates, and the payout provider. In production (NODE_ENV=production) these must be real and
// configured, and `wiring` refuses to start if any is missing. Outside production they fall back to
// dev stand-ins (a fixed 1-to-1 rate, a payout provider that approves everything) so a local run
// needs no setup.

import { createServer as nodeHttpServer } from 'node:http';

import { compose, composeWorker, loadConfig } from '#src/index.ts';
import { createServer } from '#src/server.ts';
import { jsonlLogger, systemCapabilities, toHex } from '#src/runtime.ts';
import { flatFee } from '#src/pricing.ts';
import { httpProcessor } from '#src/adapters/processor.ts';
import { configuredRates } from '#src/adapters/rates.ts';
import { decodeWebhookEvent, handlePurchaseWebhook } from '#src/webhooks.ts';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InMemoryDefaults, InMemoryPorts } from '#src/index.ts';
import type { Logger, Processor, Rates, Store } from '#src/ports.ts';
import type { Currency } from '#src/money.ts';
import type { Economy } from '#src/contract.ts';
import type { WebhookHandler } from '#src/server.ts';
import type { ReconcileFeed } from '#src/worker/reconcile.ts';

type Env = Record<string, string | undefined>;
type FetchHandler = (request: Request) => Promise<Response>;

// Returned by serve(): stops accepting new connections and resolves once the listener is
// closed, so the shutdown handler can drain before tearing the store down.
type CloseServer = () => Promise<void>;

const ENCODER = new TextEncoder();

// The host-wide structured logger. Background diagnostics (sweeps, shutdown) go here as one
// JSON line each instead of being dropped.
const log: Logger = jsonlLogger();

// How long shutdown waits for in-flight work to drain before forcing exit. A rolling deploy
// sends SIGTERM then SIGKILLs after its own grace period; this bound keeps us under that.
function shutdownTimeoutMs(env: Env): number {
  return Number(env.SHUTDOWN_TIMEOUT_MS ?? 5000);
}

// The secrets a deployed process must supply, checked once at startup. Fail fast with one clear
// message naming every missing or blank one — so an unset SIGNING_SECRET surfaces here, not as a
// cryptic zero-length-key error deep in signer setup, and an unset WEBHOOK_SECRET can never leave
// inbound callbacks silently unverified. `.env.example` ships both blank, so set any non-empty
// value for local dev; production passes real high-entropy values.
function requireSecrets(env: Env): void {
  const missing = (['SIGNING_SECRET', 'WEBHOOK_SECRET'] as const).filter(
    (key) => (env[key] ?? '') === '',
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required secret${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
        `Set ${missing.length > 1 ? 'them' : 'it'} in the environment or .env ` +
        `(any non-empty value works for local dev).`,
    );
  }
}

// Web crypto wants the signing key as hex bytes. `requireSecrets` has already rejected an unset or
// empty value, so this hex-encodes a guaranteed-non-empty secret. A production host passes a real
// high-entropy hex key.
function signingKeyHex(env: Env): string {
  return toHex(ENCODER.encode(env.SIGNING_SECRET ?? ''));
}

// A fixed CREDIT-to-USD rate source matching VRChat's published Creator Economy model, for local
// runs. Real deployments wire the rates from configuration (see productionExternals); locally the
// buy rate (what a user pays per credit) is ≈$0.00833 — 120 credits = $1 — while the par rate (the
// credit's backing/cash-out value) and the payout rate are both $0.005 — 200 credits = $1. The
// buy-vs-par gap (~40%) is VRChat's "purchase fee", the buy-vs-cash-out spread. Any other pair 1:1.
function fixedRates(): Rates {
  return {
    payout: async (from, to) =>
      from === 'CREDIT' && to === 'USD'
        ? { rate: 5n, scale: 3, rateId: 'payout:CREDIT->USD:5/3' }
        : { rate: 1n, scale: 0, rateId: `payout:${from}->${to}:1` },
    par: (currency: Currency) =>
      currency === 'CREDIT'
        ? { rate: 5n, scale: 3, rateId: 'par:CREDIT->USD:5/3' }
        : { rate: 1n, scale: 0, rateId: `par:${currency}->USD:1` },
    buy: (currency: Currency) =>
      currency === 'CREDIT'
        ? { rate: 8333n, scale: 6, rateId: 'buy:CREDIT->USD:8333/6' }
        : { rate: 1n, scale: 0, rateId: `buy:${currency}->USD:1` },
  };
}

// The dev payout provider: approves every payout and returns a made-up reference id, so a local
// worker can run the whole multi-step payout flow (reserve, submit, settle) start to finish with no
// external service. Production never uses this (see `isProduction` below).
function devProcessor(): Processor {
  return {
    submitPayout: async (input) => ({ providerRef: `dev_${input.key}` }),
  };
}

// True when this process is a production deploy. In production the externals that have no honest
// default — the CREDIT↔USD rates and the payout provider — must be real and configured; the process
// refuses to start on the dev stubs, the same fail-fast stance `requireSecrets` takes for the keys.
function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

// Build the real externals a production deploy requires from the environment, failing fast with one
// message listing everything missing or malformed — so a prod process never silently runs on the
// 1:1 dev rate or an auto-approve payout stub. Rates are the configured fixed-point CREDIT↔USD par
// and payout; the payout provider is the real HTTP provider at PROCESSOR_URL.
function productionExternals(env: Env): { rates: Rates; processor: Processor } {
  const bad: string[] = [];
  const bigintOf = (key: string): bigint => {
    const raw = env[key];
    if (raw === undefined || !/^-?\d+$/.test(raw)) {
      bad.push(key);
      return 0n;
    }
    return BigInt(raw);
  };
  const scaleOf = (key: string): number => {
    const raw = env[key];
    if (raw === undefined || !/^\d+$/.test(raw)) {
      bad.push(key);
      return 0;
    }
    return Number(raw);
  };

  const buyRate = bigintOf('CREDIT_BUY_RATE');
  const buyScale = scaleOf('CREDIT_BUY_SCALE');
  const parRate = bigintOf('CREDIT_PAR_RATE');
  const parScale = scaleOf('CREDIT_PAR_SCALE');
  const payoutRate = bigintOf('PAYOUT_RATE');
  const payoutScale = scaleOf('PAYOUT_SCALE');
  const processorUrl = env.PROCESSOR_URL ?? '';
  if (processorUrl === '') {
    bad.push('PROCESSOR_URL');
  }

  if (bad.length > 0) {
    throw new Error(
      `NODE_ENV=production requires real externals; missing or malformed: ${bad.join(', ')}. ` +
        `Set the CREDIT↔USD rates (CREDIT_BUY_RATE + CREDIT_BUY_SCALE, CREDIT_PAR_RATE + ` +
        `CREDIT_PAR_SCALE, PAYOUT_RATE + PAYOUT_SCALE) and the payout provider (PROCESSOR_URL) — ` +
        `there is no production default for these.`,
    );
  }

  return {
    rates: configuredRates({
      buyRate,
      buyScale,
      parRate,
      parScale,
      payoutRate,
      payoutScale,
    }),
    processor: httpProcessor({
      endpoint: processorUrl,
      apiKey: env.PROCESSOR_API_KEY,
    }),
  };
}

// The dev externals: a deterministic 1:1 rate and an approve-everything payout stub (or the real
// HTTP provider if PROCESSOR_URL happens to be set), so a local run and the tests need no setup.
function devExternals(env: Env): { rates: Rates; processor: Processor } {
  const endpoint = env.PROCESSOR_URL;
  return {
    rates: fixedRates(),
    processor:
      endpoint !== undefined && endpoint !== ''
        ? httpProcessor({ endpoint, apiKey: env.PROCESSOR_API_KEY })
        : devProcessor(),
  };
}

// Build the set of external-service implementations (the "ports") and the runtime defaults the
// builders need. The server and the worker share one set of runtime capabilities — the clock, the
// id generator, the hash/digest function, and the request signer — so they behave identically. The
// signer is required in every mode (enforced by `requireSecrets`); the rates and the payout provider
// are real-and-required in production and dev stand-ins otherwise.
function wiring(env: Env): {
  ports: InMemoryPorts;
  defaults: InMemoryDefaults;
} {
  requireSecrets(env);
  const caps = systemCapabilities({ signingKey: signingKeyHex(env) });
  const { rates, processor } = isProduction(env)
    ? productionExternals(env)
    : devExternals(env);
  return {
    ports: {
      signer: caps.signer,
      processor,
      rates,
      pricing: flatFee(),
    },
    defaults: { clock: caps.clock, ids: caps.ids, digest: caps.digest },
  };
}

// --- webhook ingestion ------------------------------------------------------------

// Build the handler for inbound "purchase" webhooks (callbacks the payment provider sends us when a
// user buys credit). The serve path passes this into createServer. By the time this handler runs,
// the server has already confirmed the message is authentic (it checked the provider's signature),
// confirmed it is recent (rejecting old timestamps), and — when a store of seen events is wired —
// recorded the provider's event id so the same event is not processed twice. So the body here is
// trusted and seen for the first time.
//
// The handler turns the verified body into a typed event and adds the credit by calling the
// economy's "topUp" (add funds to a user's balance). That credit carries an idempotency key — a
// value derived from the event id that lets a retried request run at most once: a repeat with the
// same key is recognized and not applied again. So even a duplicate delivery that slips past the
// seen-events check still credits the user only once.
//
// On a malformed body or any thrown error, the response carries only the error message and the
// mapped status code, never internal details.
function purchaseWebhook(economy: Economy): WebhookHandler {
  return async (provider, request) => {
    try {
      let body = await request.json();
      let event = decodeWebhookEvent(provider, body);
      let outcome = await handlePurchaseWebhook(economy, event);
      return new Response(JSON.stringify({ status: outcome.status }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Webhook failed.';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  };
}

// --- serve ------------------------------------------------------------------------

// Run the Fetch handler on whatever runtime we're on. Bun and Deno serve a Fetch handler
// directly; on Node we bridge node:http to the Web Request/Response the handler speaks, so the
// same server code (src/server.ts, Fetch-only) runs everywhere. Returns a closer that stops
// accepting new connections and resolves once the listener is down, so a SIGTERM can drain in
// flight before the store is closed.
function serve(handler: FetchHandler, port: number): CloseServer {
  const runtime = globalThis as unknown as {
    Bun?: {
      serve(o: { port: number; fetch: FetchHandler }): { stop(): unknown };
    };
    Deno?: {
      serve(
        o: { port: number },
        h: FetchHandler,
      ): { shutdown(): Promise<void> };
    };
  };
  if (runtime.Bun?.serve) {
    const server = runtime.Bun.serve({ port, fetch: handler });
    log.log('info', 'http.listening', { port, runtime: 'Bun' });
    return async () => {
      await server.stop();
    };
  }
  if (runtime.Deno?.serve) {
    const server = runtime.Deno.serve({ port }, handler);
    log.log('info', 'http.listening', { port, runtime: 'Deno' });
    return async () => {
      await server.shutdown();
    };
  }
  const server = nodeHttpServer((req, res) => {
    void bridge(handler, req, res);
  });
  server.listen(port, () =>
    log.log('info', 'http.listening', { port, runtime: 'Node' }),
  );
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
}

// Pass one node:http request/response pair through the Fetch handler.
async function bridge(
  handler: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const method = req.method ?? 'GET';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      headers.set(name, value.join(', '));
    }
  }
  const hasBody = method !== 'GET' && method !== 'HEAD' && chunks.length > 0;
  const request = new Request(
    `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`,
    { method, headers, body: hasBody ? Buffer.concat(chunks) : undefined },
  );
  const response = await handler(request);
  res.writeHead(
    response.status,
    Object.fromEntries(response.headers.entries()),
  );
  res.end(Buffer.from(await response.arrayBuffer()));
}

// --- worker -----------------------------------------------------------------------

// The reconcile feed is an external integration with no local default. The local worker passes no
// windows, so this is never pulled — it exists only to satisfy the sweep input's shape.
const noReconcileFeed: ReconcileFeed = {
  pull: async () => {
    throw new Error('no reconcile feed configured');
  },
};

// A running worker: its interval handle, the store to close on shutdown, and a promise to await
// before tearing the store down (resolved when the current tick, if any, finishes).
type RunningWorker = {
  timer: NodeJS.Timeout;
  store: Store;
  drain: () => Promise<void>;
};

async function runWorker(env: Env): Promise<RunningWorker> {
  const { ports, defaults } = wiring(env);
  const { worker, store, dispatcher } = await composeWorker(
    env,
    ports,
    defaults,
  );
  const intervalMs = Number(env.WORKER_INTERVAL_MS ?? 60_000);
  const limit = Number(env.WORKER_BATCH ?? 100);

  // Non-overlap guard: a single in-flight promise so a slow sweep never overlaps the next
  // scheduled tick (which would run two sweeps at the same time in one process). While a tick
  // is running, later interval fires are skipped; the shutdown handler awaits this same promise.
  let inFlight: Promise<void> | null = null;

  const tick = (): Promise<void> => {
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      try {
        const batch = await worker.runOnce({
          now: Date.now(),
          limit,
          dispatcher,
          feed: noReconcileFeed,
          windows: [],
        });
        const failed = Object.entries(batch)
          .filter(([, result]) => !result.ok)
          .map(([name]) => name);
        if (failed.length === 0) {
          log.log('info', 'worker.sweep', { ok: true });
        } else {
          log.log('warn', 'worker.sweep', { ok: false, failed });
        }
      } catch (error) {
        log.log('error', 'worker.sweep_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  await tick();
  const timer = setInterval(() => void tick(), intervalMs);
  log.log('info', 'worker.started', { intervalMs, batch: limit });

  return {
    timer,
    store,
    drain: async () => {
      if (inFlight) {
        await inFlight;
      }
    },
  };
}

// --- shutdown ---------------------------------------------------------------------

// Register SIGTERM/SIGINT handlers that run `drain` (stop accepting work, await in flight)
// exactly once, then exit 0. A bounded, unref'd timer forces exit 1 if a drain hangs, so a
// rolling deploy is never blocked waiting on a stuck connection or sweep.
function onShutdown(env: Env, drain: () => Promise<void>): void {
  let started = false;
  const shutdown = (signal: string): void => {
    if (started) {
      return;
    }
    started = true;
    log.log('warn', 'process.shutting_down', { signal });
    const forced = setTimeout(() => {
      log.log('error', 'process.shutdown_timeout', {});
      // eslint-disable-next-line n/no-process-exit
      process.exit(1);
    }, shutdownTimeoutMs(env));
    forced.unref();
    drain().then(
      () => {
        clearTimeout(forced);
        // eslint-disable-next-line n/no-process-exit
        process.exit(0);
      },
      (error) => {
        clearTimeout(forced);
        log.log('error', 'process.shutdown_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        // eslint-disable-next-line n/no-process-exit
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// --- serve (shared by `serve` and `dev`) ------------------------------------------

// Build the economy from `env`, mount the HTTP handler with the active webhook gate, start the
// listener, and register graceful shutdown. `serve` and `dev` both use this and differ only in the
// env they pass: `dev` forces in-memory adapters and dev secrets (see `devEnv`).
async function runServe(env: Env): Promise<void> {
  const { ports, defaults } = wiring(env);
  const economy = await compose(env, ports, defaults);
  const config = loadConfig(env);
  // Mount the purchase-webhook handler together with the checks that make webhook security active:
  // the config and clock let the server verify each callback's signature and timestamp, so a genuine
  // callback becomes a topUp and a forged or stale one is rejected before it changes anything. The
  // store that remembers already-seen events is not passed in here, because `compose` returns the
  // economy but not its underlying store. That is fine: the topUp's idempotency key (derived from
  // the event id) still ensures the ledger credits each event at most once.
  const handler = createServer(economy, {
    webhook: purchaseWebhook(economy),
    config,
    clock: defaults.clock,
  });
  const closeServer = serve(handler, Number(env.PORT ?? 3000));
  onShutdown(env, async () => {
    await closeServer();
    await economy.close();
  });
}

// The env for `dev` mode: force the in-memory adapters (ignore any DATABASE_URL / REDIS_URL / queue
// from .env or the shell) and supply dev secrets when none are set, so `npm run dev` boots with no
// database and no configured secrets — and, run under `node --watch`, reloads on edit. Not for prod.
function devEnv(env: Env): Env {
  return {
    ...env,
    DATABASE_URL: undefined,
    REDIS_URL: undefined,
    SQS_QUEUE_URL: undefined,
    DISPATCHER_URL: undefined,
    SIGNING_SECRET: env.SIGNING_SECRET || 'dev-signing-secret',
    WEBHOOK_SECRET: env.WEBHOOK_SECRET || 'dev-webhook-secret',
  };
}

// --- entry ------------------------------------------------------------------------

const mode = process.argv[2] ?? 'serve';
if (mode === 'worker') {
  const running = await runWorker(process.env);
  onShutdown(process.env, async () => {
    clearInterval(running.timer);
    await running.drain();
    await running.store.close();
  });
} else if (mode === 'serve') {
  await runServe(process.env);
} else if (mode === 'dev') {
  log.log('info', 'dev.mode', {
    note: 'in-memory store, dev secrets, hot reload — not for production',
  });
  await runServe(devEnv(process.env));
} else {
  console.error(`unknown mode "${mode}"; use "serve", "dev", or "worker"`);
  // eslint-disable-next-line n/no-process-exit
  process.exit(1);
}
