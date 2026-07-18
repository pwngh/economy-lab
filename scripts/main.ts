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

// App entry: the one place env is read. argv[2] picks the mode:
//
//   scripts/main.ts serve   # HTTP API on $PORT (default 3000); adapters come from env
//   scripts/main.ts dev     # same API, forced in-memory with dev secrets; `make dev`
//   scripts/main.ts worker  # maintenance sweep every $WORKER_INTERVAL_MS
//
// In production (NODE_ENV=production) the signer, the CREDIT-to-USD rates, and the payout provider
// must be real; otherwise dev stand-ins apply, so a local run needs no setup. This entry lives in
// scripts/ so the rest of src/ can stay runtime-agnostic.

import { createServer as nodeHttpServer } from 'node:http';

import {
  capabilitiesFromEnv,
  composeWorker,
  describeSelection,
  externalsFromEnv,
} from '#src/index.ts';
import { REQUIRED_SECRETS, isProduction, missingSecrets } from '#src/env.ts';
import { serverRuntime } from '#scripts/support/server-env.ts';
import { economyFromCapabilities } from '#src/economy.ts';
import {
  CLIENT_IP_HEADER,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_READ_TIMEOUT_MS,
  createServer,
} from '#src/server.ts';
import {
  jsonlLogger,
  randomIds,
  systemClock,
  systemDigest,
} from '#src/runtime.ts';
import { ERROR_CODES, EconomyError } from '#src/errors.ts';
import { decodeWebhookEvent, handlePurchaseWebhook } from '#src/webhooks.ts';
import { describeTaskq, maybeTaskqHost } from '#scripts/support/taskq-host.ts';
import { maybeEdgeTilia } from '#scripts/support/edge-host.ts';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EnvMap } from '#src/env.ts';
import type { ServerRuntime } from '#scripts/support/server-env.ts';
import type { ExternalPorts, RuntimeDefaults } from '#src/index.ts';
import type { Clock, Ids, Logger, Meter, Store } from '#src/ports.ts';
import type { WebhookHandler } from '#src/server.ts';

type FetchHandler = (request: Request) => Promise<Response>;

type CloseServer = () => Promise<void>;

const log: Logger = jsonlLogger();

// Fails fast at startup naming every missing or blank secret, rather than deep in signer setup or
// as an unverified inbound callback.
function requireSecrets(env: EnvMap): void {
  const missing = missingSecrets(env);
  if (missing.length > 0) {
    throw new Error(
      `Missing required secret${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
        `Set ${missing.length > 1 ? 'them' : 'it'} in the environment or .env ` +
        `(any non-empty value works for local dev).`,
    );
  }
}

function wiring(env: EnvMap): {
  ports: ExternalPorts;
  defaults: RuntimeDefaults;
} {
  requireSecrets(env);
  // externalsFromEnv resolves the four external ports from env with the same dev-default and
  // production-required rules the library applies in createEconomy; no hand-rolled wiring here.
  return {
    ports: externalsFromEnv(env),
    defaults: {
      clock: systemClock(),
      ids: randomIds(),
      digest: systemDigest(),
    },
  };
}

// --- webhook ingestion ------------------------------------------------------------

// createServer runs the verification gate first, so the body here is already trusted. The decoded
// "topUp" is persisted to the inbox (deduped on the provider event id) rather than posted inline:
// ack fast, and the apply worker (`drainInbox`) settles off the request path.
function purchaseWebhook(
  store: Store,
  ids: Ids,
  clock: Clock,
  meter?: Meter,
): WebhookHandler {
  return async (provider, request) => {
    try {
      const body = await request.json();
      const event = decodeWebhookEvent(provider, body);
      const ack = await handlePurchaseWebhook(
        store,
        { ids, clock, meter },
        event,
      );
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

// The returned closer stops accepting connections and resolves once the listener is down, so a
// SIGTERM can drain in-flight work before the store is closed.
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

async function bridge(
  handler: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  let received = 0;
  // The Fetch handler only ever sees a fully buffered body, so the byte ceiling and read
  // deadline must act here, while the bytes stream in.
  const timer = setTimeout(() => {
    problem(res, 408, 'Request body read timed out.');
    req.destroy();
  }, DEFAULT_READ_TIMEOUT_MS);
  try {
    for await (const chunk of req) {
      received += (chunk as Buffer).byteLength;
      if (received > DEFAULT_MAX_BODY_BYTES) {
        problem(res, 413, 'Request body is too large.');
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
  } catch {
    // Destroyed mid-read after a ceiling or deadline reply; nothing more to send.
    return;
  } finally {
    clearTimeout(timer);
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
  // Always overwrite: the socket, not the caller, says who is connecting.
  headers.set(CLIENT_IP_HEADER, req.socket.remoteAddress ?? 'unknown');
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

function problem(res: ServerResponse, status: number, title: string): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ type: 'about:blank', title, status }));
}

// --- worker -----------------------------------------------------------------------

type RunningWorker = {
  timer: NodeJS.Timeout;
  store: Store;
  drain: () => Promise<void>;
};

async function runWorker(
  env: EnvMap,
  runtime: ServerRuntime,
): Promise<RunningWorker> {
  const { ports, defaults } = wiring(env);
  const edge = await maybeEdgeTilia(env, log);
  if (edge !== undefined) {
    ports.processor = edge.processor;
  }
  const { worker, store, dispatcher } = await composeWorker(
    env,
    ports,
    defaults,
  );
  const bridge = await maybeTaskqHost(env, log);
  const relayDispatcher = bridge?.dispatcher ?? dispatcher;
  const { workerIntervalMs: intervalMs, workerBatch: limit } = runtime;

  // Non-overlap guard: while a tick runs, later interval fires are skipped. The shutdown handler
  // awaits this same promise.
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
          dispatcher: relayDispatcher,
          float: edge?.float,
        });
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
      if (bridge !== undefined) {
        await bridge.stop();
      }
      await edge?.stop();
    },
  };
}

// --- shutdown ---------------------------------------------------------------------

// `drain` runs once and exits 0; a bounded, unref'd timer forces exit 1 if it hangs, so a rolling
// deploy isn't blocked on a stuck connection or sweep.
function onShutdown(timeoutMs: number, drain: () => Promise<void>): void {
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
    }, timeoutMs);
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
 * Shared by `serve` and `dev`, which differ only in the env they pass (see `devEnv`).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 * the routes, wire format, and webhook gate this entry point mounts.
 */
async function runServe(env: EnvMap, runtime: ServerRuntime): Promise<void> {
  const { ports, defaults } = wiring(env);
  const edge = await maybeEdgeTilia(env, log);
  if (edge !== undefined) {
    ports.processor = edge.processor;
  }
  // capabilitiesFromEnv rather than compose: the webhook handler writes the inbox, so it needs the
  // same store handle the economy runs on, and compose would return only the economy.
  const caps = await capabilitiesFromEnv(env, ports, defaults);
  if (edge !== undefined) {
    caps.payees = edge.payees;
  }
  const economy = economyFromCapabilities(caps);
  const config = caps.config;
  const purchases = purchaseWebhook(
    caps.store,
    caps.ids,
    caps.clock,
    caps.meter,
  );
  const tiliaPayouts = edge?.webhookFor(caps.store, caps.ids, caps.clock);
  // config and clock are what activate the webhook gate. Without them createServer can't verify a
  // callback's signature and timestamp, so a forged or stale one would reach the handler unchecked.
  const handler = createServer(economy, {
    webhook: async (provider, request) =>
      provider === 'tilia' && tiliaPayouts !== undefined
        ? tiliaPayouts(provider, request)
        : purchases(provider, request),
    config,
    clock: defaults.clock,
    meter: caps.meter,
  });
  const closeServer = serve(handler, runtime.port);
  onShutdown(runtime.shutdownTimeoutMs, async () => {
    await closeServer();
    await economy.close();
    await edge?.stop();
  });
}

// Forces in-memory adapters by clearing any store, cache, or queue URL from .env or the shell, and
// supplies dev secrets when none are set. Not for production.
function devEnv(env: EnvMap): EnvMap {
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

// One startup line naming the resolved selection and knobs; each secret logs set/MISSING, never
// its value. It reads describeSelection — the same reading the wiring consumes — so the line
// cannot drift from what actually runs.
function logResolved(mode: string, env: EnvMap, runtime: ServerRuntime): void {
  const selection = describeSelection(env);
  // describeTaskq throws on a misconfigured opt-in; startup, right here, is where that surfaces.
  const queue = mode === 'worker' ? describeTaskq(env) : null;
  log.log('info', 'config.resolved', {
    mode,
    production: isProduction(env),
    store: selection.store.kind,
    cache: selection.cache.kind,
    dispatcher: selection.dispatcher.kind,
    ...(mode === 'worker' && queue !== null
      ? {
          workerIntervalMs: runtime.workerIntervalMs,
          workerBatch: runtime.workerBatch,
          queue: queue.kind === 'off' ? 'off' : `taskq(${queue.engine})`,
        }
      : { port: runtime.port }),
    shutdownTimeoutMs: runtime.shutdownTimeoutMs,
    secrets: Object.fromEntries(
      REQUIRED_SECRETS.map((key) => [
        key,
        (env[key] ?? '') === '' ? 'MISSING' : 'set',
      ]),
    ),
  });
}

// --- entry ------------------------------------------------------------------------

const mode = process.argv[2] ?? 'serve';
if (mode !== 'serve' && mode !== 'dev' && mode !== 'worker') {
  console.error(`unknown mode "${mode}"; use "serve", "dev", or "worker"`);
  // eslint-disable-next-line n/no-process-exit
  process.exit(1);
}
if (mode === 'dev') {
  log.log('info', 'dev.mode', {
    note: 'in-memory store, dev secrets, hot reload — not for production',
  });
}
const env: EnvMap = mode === 'dev' ? devEnv(process.env) : process.env;
const runtime = serverRuntime(env);
logResolved(mode, env, runtime);

if (mode === 'worker') {
  const running = await runWorker(env, runtime);
  onShutdown(runtime.shutdownTimeoutMs, async () => {
    clearInterval(running.timer);
    await running.drain();
    await running.store.close();
  });
} else {
  await runServe(env, runtime);
}
