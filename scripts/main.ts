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

// App entry: reads env, picks concrete external deps (store, cache, dispatcher), and hands them to
// `compose`/`composeWorker` (src/index.ts). Env access happens only here. Three modes, selected by
// argv[2]:
//
//   scripts/main.ts serve   # HTTP API on $PORT (default 3000); store/cache/dispatcher come from env
//   scripts/main.ts dev     # same API, forced in-memory with dev secrets, no infra; `make dev`
//   scripts/main.ts worker  # background loop running the maintenance sweep every $WORKER_INTERVAL_MS
//
// serve and dev run the src/server.ts handler, which speaks web Request/Response. On Node we
// translate node:http to web Requests (see `bridge`, below). That translation is why this entry
// lives in scripts/, so the rest of src/ can stay runtime-agnostic.
//
// Three externals have no safe default: the request signer, the CREDIT-to-USD rates, and the payout
// provider. In production (NODE_ENV=production) they must be real and configured; `wiring` refuses to
// start if any is missing. Otherwise they fall back to dev stand-ins (fixed dev rates, approve-all
// payout) so a local run needs no setup.

import { createServer as nodeHttpServer } from 'node:http';

import { capabilitiesFromEnv, composeWorker, loadConfig } from '#src/index.ts';
import { createEconomy } from '#src/economy.ts';
import { createServer } from '#src/server.ts';
import { jsonlLogger, systemCapabilities, toHex } from '#src/runtime.ts';
import { flatFee } from '#src/pricing.ts';
import { ERROR_CODES, EconomyError } from '#src/errors.ts';
import { httpProcessor } from '#src/adapters/processor.ts';
import { configuredRates } from '#src/adapters/rates.ts';
import { decodeWebhookEvent, handlePurchaseWebhook } from '#src/webhooks.ts';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExternalPorts, RuntimeDefaults } from '#src/index.ts';
import type {
  Clock,
  Ids,
  Logger,
  Processor,
  Rates,
  Store,
} from '#src/ports.ts';
import type { Currency } from '#src/money.ts';
import type { WebhookHandler } from '#src/server.ts';
import type { ReconcileFeed } from '#src/worker/reconcile.ts';

type Env = Record<string, string | undefined>;
type FetchHandler = (request: Request) => Promise<Response>;

// The closer returned by serve(). It stops accepting new connections and resolves once the listener
// is closed, so the shutdown handler can drain before tearing the store down.
type CloseServer = () => Promise<void>;

const ENCODER = new TextEncoder();

// Host-wide structured logger. Background diagnostics (sweeps, shutdown) go here as one JSON line each.
const log: Logger = jsonlLogger();

// Returns how long shutdown waits for in-flight work to drain before forcing exit. A rolling deploy
// sends SIGTERM, then SIGKILLs after its own grace period. This bound keeps us under that.
function shutdownTimeoutMs(env: Env): number {
  return Number(env.SHUTDOWN_TIMEOUT_MS ?? 5000);
}

// Checks at startup that a deployed process supplied every required secret. Fails fast naming every
// missing or blank one, so an unset SIGNING_SECRET surfaces here rather than as a zero-length-key
// error deep in signer setup, and an unset WEBHOOK_SECRET can't leave inbound callbacks unverified.
// `.env.example` ships both blank. Set any non-empty value for local dev. Production passes real
// high-entropy values.
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

// Encodes the signing key as the hex bytes web crypto wants. `requireSecrets` already rejected an
// unset or empty value, so this hex-encodes a non-empty secret. Production passes a real
// high-entropy hex key.
function signingKeyHex(env: Env): string {
  return toHex(ENCODER.encode(env.SIGNING_SECRET ?? ''));
}

// Provides a fixed CREDIT-to-USD rate source for local runs, modeling a dual-rate credit economy.
// Real deployments wire rates from config (see productionExternals). The buy rate is the
// acquisition rate a user pays per credit, about $0.00833 (120 credits = $1). The par rate (the
// credit's redemption value) and the payout rate (the settlement rate) are both $0.005 (200 credits
// = $1). The roughly 40% gap between buy and par is the platform spread. Any other currency pair
// stays 1:1.
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

// Builds the dev payout provider. It approves every payout and returns a made-up reference id, so a
// local worker can run the full payout flow (reserve, submit, settle) with no external service.
// Production never uses this (see `isProduction` below).
function devProcessor(): Processor {
  return {
    submitPayout: async (input) => ({ providerRef: `dev_${input.key}` }),
  };
}

// Reports whether this process is a production deploy. In production the externals with no honest
// default (the CREDIT-to-USD rates and the payout provider) must be real and configured. The
// process refuses to start on dev stubs, the same fail-fast stance `requireSecrets` takes for the
// keys.
function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

// Builds the real externals a production deploy requires from env. Fails fast with one message
// listing everything missing or malformed, so a prod process never runs on the fixed dev rates or an
// auto-approve payout stub. The rates are the configured fixed-point CREDIT-to-USD par and payout.
// The payout provider is the real HTTP provider at PROCESSOR_URL.
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
        `Set the CREDIT-to-USD rates (CREDIT_BUY_RATE + CREDIT_BUY_SCALE, CREDIT_PAR_RATE + ` +
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

// Builds the dev externals. The rates are the fixed dev rates (`fixedRates`) and the payout
// provider approves everything, or it is the real HTTP provider if PROCESSOR_URL is set. This way a
// local run and the tests need no setup.
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

// Builds the external-service implementations (the "ports") and the runtime defaults the builders
// need. The server and the worker share one set of runtime capabilities (clock, id generator,
// hash/digest, request signer) so they behave identically. The signer is required in every mode
// (via `requireSecrets`). The rates and the payout provider are real and required in production, and
// dev stand-ins otherwise.
function wiring(env: Env): {
  ports: ExternalPorts;
  defaults: RuntimeDefaults;
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

// Handles inbound "purchase" webhooks. createServer runs the verification gate first, so the body
// here is already trusted and first-seen. This decodes it and persists the resulting "topUp" to the
// inbox rather than posting inline, so we ack fast and the apply worker (`drainInbox`) settles off
// the request path. The inbox dedupes on the provider event id, so a redelivery credits the user
// once. On any thrown error the response carries only the message, never internal details.
function purchaseWebhook(store: Store, ids: Ids, clock: Clock): WebhookHandler {
  return async (provider, request) => {
    try {
      const body = await request.json();
      const event = decodeWebhookEvent(provider, body);
      const ack = await handlePurchaseWebhook(store, { ids, clock }, event);
      return new Response(JSON.stringify({ status: ack.status }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      // A malformed body is the caller's fault and maps to 400, the same verdict server.ts's own
      // fault mapping gives it; anything else stays a 500. Only the message leaves the process.
      const isClientFault =
        error instanceof EconomyError &&
        (error.code === ERROR_CODES.MALFORMED_OPERATION ||
          error.code === ERROR_CODES.INVALID_AMOUNT);
      const status = isClientFault ? 400 : 500;
      const title = error instanceof Error ? error.message : 'Webhook failed.';
      return new Response(
        JSON.stringify({ type: 'about:blank', title, status }),
        { status, headers: { 'content-type': 'application/problem+json' } },
      );
    }
  };
}

// --- serve ------------------------------------------------------------------------

// Runs the Fetch handler on the current runtime. Bun and Deno serve it directly, and Node goes
// through `bridge`. Returns a closer that stops accepting connections and resolves once the listener
// is down, so a SIGTERM can drain in-flight work before the store is closed.
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

// Passes one node:http request/response pair through the Fetch handler.
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
// windows, so this is never pulled; it exists only to satisfy the sweep input's shape.
const noReconcileFeed: ReconcileFeed = {
  pull: async () => {
    throw new Error('no reconcile feed configured');
  },
};

// A running worker. It holds the interval handle, the store to close on shutdown, and a promise to
// await before tearing the store down (resolved when the current tick, if any, finishes).
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

  // Non-overlap guard. A single in-flight promise keeps a slow sweep from overlapping the next
  // scheduled tick, which would run two sweeps at once in one process. While a tick runs, later
  // interval fires are skipped. The shutdown handler awaits this same promise.
  let inFlight: Promise<void> | null = null;

  const tick = (): Promise<void> => {
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      try {
        const { batch } = await worker.runOnce({
          now: Date.now(),
          limit,
          dispatcher,
          feed: noReconcileFeed,
          windows: [],
        });
        // Surface each failed sweep's error code and retry flag, not just its name. The SweepResult
        // carries why it failed (STORE.FAILURE, COMMINGLING, and so on) and whether the next tick
        // retries it, which is what an operator needs to act. flatMap narrows `result` to the failure
        // variant, so no cast.
        const failed = Object.entries(batch).flatMap(([sweep, result]) =>
          result.ok
            ? []
            : [{ sweep, code: result.code, retryable: result.retryable }],
        );
        if (failed.length === 0) {
          log.log('info', 'worker.sweep', { ok: true });
        } else {
          log.log('warn', 'worker.sweep', { ok: false, failed });
        }
      } catch (error) {
        // Same event as the per-tick lines above: the outcome lives in the fields (`ok`, `error`)
        // and the level, not in a differently named event.
        log.log('error', 'worker.sweep', {
          ok: false,
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

// Registers SIGTERM and SIGINT handlers. They run `drain` once (stop accepting work, then await
// in-flight work) and exit 0. A bounded, unref'd timer forces exit 1 if a drain hangs, so a rolling
// deploy isn't blocked on a stuck connection or sweep.
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

/**
 * Build the economy from `env`, mount the HTTP handler with the active webhook gate, start the
 * listener, register graceful shutdown. `serve` and `dev` both use this, differing only in the env
 * they pass: `dev` forces in-memory adapters and dev secrets (see `devEnv`).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 * the routes, wire format, and webhook gate this entry point mounts.
 */
async function runServe(env: Env): Promise<void> {
  const { ports, defaults } = wiring(env);
  // Build the capability bundle once so the economy and the webhook handler share one store, id
  // generator, and clock. The handler persists each verified callback into the very store the apply
  // worker (`drainInbox`) later drains. `compose` would return only the economy, not its store, but
  // the webhook now writes to the inbox, so we need the store handle.
  const caps = await capabilitiesFromEnv(env, ports, defaults);
  const economy = createEconomy(caps);
  const config = loadConfig(env);
  // config and clock are what activate the webhook gate. Without them createServer can't verify a
  // callback's signature and timestamp, so a forged or stale one would reach the handler unchecked.
  const handler = createServer(economy, {
    webhook: purchaseWebhook(caps.store, caps.ids, caps.clock),
    config,
    clock: defaults.clock,
  });
  const closeServer = serve(handler, Number(env.PORT ?? 3000));
  onShutdown(env, async () => {
    await closeServer();
    await economy.close();
  });
}

// Builds the env for `dev` mode. It forces in-memory adapters by clearing any DATABASE_URL,
// REDIS_URL, or queue URL from .env or the shell, and it supplies dev secrets when none are set. So
// `make dev` boots with no database and no configured secrets, and under `node --watch` it reloads
// on edit. Not for production.
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
