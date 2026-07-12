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

// Optional host-layer bridge to the @pwngh/economy-edge Tilia rail: the shimmed
// processor replaces the HTTP one, the hosted-KYC directory feeds the
// PAYEE_UNVERIFIED gate, the wallet balance feeds the floatCoverage sweep, and
// a webhook handler turns the rail's payout callbacks into inbox operations.
// Off unless TILIA_CLIENT_ID is set; the core never sees any of this — the
// edge stays a host concern behind the same seams every processor uses. An
// explicit opt-in with missing pieces fails loudly, mirroring
// productionExternals and the taskq bridge.

import {
  edgePayoutWebhookEvent,
  payoutEventIdOf,
  sagaByProviderRef,
} from '#src/adapters/edge-webhooks.ts';
import { handleWebhook } from '#src/webhooks.ts';

import type { SignatureScheme } from '@pwngh/economy-edge';
import type { EdgeTiliaCapabilities } from '#src/adapters/edge-tilia.ts';
import type { WebhookHandler } from '#src/server.ts';
import type {
  Clock,
  Ids,
  Logger,
  PayeeDirectory,
  Processor,
  Store,
} from '#src/ports.ts';
import type { FloatFeed } from '#src/worker/treasury.ts';

type Env = Record<string, string | undefined>;

export interface EdgeHost {
  processor: Processor;
  payees: PayeeDirectory;
  float: FloatFeed;
  webhookFor(store: Store, ids: Ids, clock: Clock): WebhookHandler;
  stop(): Promise<void>;
}

interface PgPoolLike {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}

interface PgModule {
  default: {
    Pool: new (config: {
      connectionString: string;
      max?: number;
    }) => PgPoolLike;
  };
}

interface TiliaPayeeRow {
  accountId: string;
  sourcePaymentMethodId: string;
  destinationPaymentMethodId: string;
}

// Parses TILIA_PAYEE_MAP: a JSON object mapping lab user ids to their Tilia
// routing. The ids are minted by Tilia's hosted onboarding, so they enter as
// configuration; a host that owns user identity resolves them from its own
// records through the same resolvePayee callback.
function payeeMapOf(raw: string): Record<string, TiliaPayeeRow> {
  const parsed = JSON.parse(raw) as Record<string, Partial<TiliaPayeeRow>>;
  const map: Record<string, TiliaPayeeRow> = {};
  for (const [userId, row] of Object.entries(parsed)) {
    if (
      typeof row?.accountId !== 'string' ||
      typeof row.sourcePaymentMethodId !== 'string' ||
      typeof row.destinationPaymentMethodId !== 'string'
    ) {
      throw new Error(
        `TILIA_PAYEE_MAP entry for ${userId} must carry accountId, sourcePaymentMethodId, and destinationPaymentMethodId`,
      );
    }
    map[userId] = {
      accountId: row.accountId,
      sourcePaymentMethodId: row.sourcePaymentMethodId,
      destinationPaymentMethodId: row.destinationPaymentMethodId,
    };
  }
  return map;
}

interface TiliaSettings {
  clientId: string;
  clientSecret: string;
  integratorAccountId: string;
  environment: 'staging' | 'production';
  payeeDbUrl: string;
  payeeMapRaw: string;
  webhookSecret: string;
}

// Gathers and validates every env knob in one pass, throwing one error that
// lists everything missing or malformed. Payees resolve from the durable
// store when a database is configured; the env JSON map is the dev-shaped
// fallback. Production callbacks must also be cryptographically verified.
// Both are hard requirements on the production rail — the same fail-fast
// stance productionExternals takes.
function tiliaSettings(env: Env, clientId: string): TiliaSettings {
  const bad: string[] = [];
  const requireOf = (key: string): string => {
    const value = env[key];
    if (value === undefined || value === '') {
      bad.push(key);
      return '';
    }
    return value;
  };
  const clientSecret = requireOf('TILIA_CLIENT_SECRET');
  const integratorAccountId = requireOf('TILIA_ACCOUNT_ID');
  const environment = env.TILIA_ENVIRONMENT ?? 'staging';
  if (environment !== 'staging' && environment !== 'production') {
    bad.push('TILIA_ENVIRONMENT');
  }
  const payeeDbUrl = env.TILIA_PAYEE_DATABASE_URL ?? '';
  const payeeMapRaw = payeeDbUrl === '' ? requireOf('TILIA_PAYEE_MAP') : '';
  const webhookSecret = env.TILIA_WEBHOOK_SECRET ?? '';
  if (environment === 'production') {
    if (payeeDbUrl === '') {
      bad.push('TILIA_PAYEE_DATABASE_URL (production resolves payees durably)');
    }
    if (webhookSecret === '') {
      bad.push('TILIA_WEBHOOK_SECRET (production callbacks must be signed)');
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `TILIA_CLIENT_ID is set but the bridge is incomplete; missing or malformed: ${bad.join(', ')}`,
    );
  }
  return {
    clientId,
    clientSecret,
    integratorAccountId,
    environment: environment as 'staging' | 'production',
    payeeDbUrl,
    payeeMapRaw,
    webhookSecret,
  };
}

// Builds the payee resolver: the durable store when a database is configured
// (bootstrapping its table at startup), the env map otherwise. The pool comes
// back so the host can close it on drain.
async function payeeSource(settings: TiliaSettings): Promise<{
  pool: PgPoolLike | undefined;
  resolvePayee: (userId: string) => Promise<TiliaPayeeRow>;
}> {
  if (settings.payeeDbUrl === '') {
    const payeeMap = payeeMapOf(settings.payeeMapRaw);
    return {
      pool: undefined,
      resolvePayee: async (userId) => {
        const payee = payeeMap[userId];
        if (payee === undefined) {
          throw new Error(
            `no Tilia payee mapping for ${userId}; extend TILIA_PAYEE_MAP or set TILIA_PAYEE_DATABASE_URL`,
          );
        }
        return payee;
      },
    };
  }
  // @ts-expect-error -- `pg` ships no types; typed at the binding via PgModule, the same pattern
  // src/engines/postgres.ts uses for its static import.
  const { default: pg } = (await import('pg')) as unknown as PgModule;
  const pool: PgPoolLike = new pg.Pool({
    connectionString: settings.payeeDbUrl,
    max: 3,
  });
  pool.on('error', () => undefined);
  const { tiliaPayeeStore } = await import('#src/adapters/tilia-payees.ts');
  const store = tiliaPayeeStore(pool);
  await store.ensureSchema();
  return { pool, resolvePayee: store.resolve };
}

// Picks the callback verification scheme: HMAC when a secret is configured,
// transport otherwise — loudly, because unsigned callbacks are a staging-only
// posture.
function verificationScheme(
  env: Env,
  settings: TiliaSettings,
  logger: Logger,
): SignatureScheme {
  if (settings.webhookSecret === '') {
    logger.log('warn', 'edge.tilia_webhooks_unsigned', {
      hint: 'set TILIA_WEBHOOK_SECRET to verify callbacks cryptographically',
    });
    return { scheme: 'transport' };
  }
  return {
    scheme: 'hmac-sha256',
    secret: settings.webhookSecret,
    // Placeholder header name pending the ratified envelope; override it the
    // day staging answers with the real one.
    header: env.TILIA_WEBHOOK_SIGNATURE_HEADER ?? 'x-tilia-signature',
  };
}

/**
 * Builds the bridge when TILIA_CLIENT_ID opts in; resolves undefined when it
 * does not, and the env-selected processor is used unchanged. The edge
 * package loads dynamically, so a deployment without the optional peer never
 * pays its import.
 */
export async function maybeEdgeTilia(
  env: Env,
  logger: Logger,
): Promise<EdgeHost | undefined> {
  const clientId = env.TILIA_CLIENT_ID;
  if (clientId === undefined || clientId === '') {
    return undefined;
  }
  const settings = tiliaSettings(env, clientId);
  const { pool, resolvePayee } = await payeeSource(settings);
  const webhookVerification = verificationScheme(env, settings, logger);

  const { edgeTiliaCapabilities } = await import('#src/adapters/edge-tilia.ts');
  const capabilities = edgeTiliaCapabilities({
    environment: settings.environment,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    integratorAccountId: settings.integratorAccountId,
    resolvePayee,
    webhookVerification,
  });

  logger.log('info', 'edge.tilia_ready', {
    environment: settings.environment,
    payees: settings.payeeDbUrl === '' ? 'env-map' : 'store',
    webhooks: webhookVerification.scheme,
  });
  return {
    processor: capabilities.processor,
    payees: capabilities.payees,
    float: capabilities.float,
    webhookFor: (store, ids, clock) =>
      tiliaWebhook(capabilities, store, { ids, clock }),
    stop: async () => {
      await pool?.end();
    },
  };
}

// Handles the rail's payout callbacks for POST /webhooks/tilia. The signature
// check runs before anything reads the body's claims; a callback that fails it
// gets a 401 so a misconfigured secret surfaces as rail-side retries, never as
// silently accepted events. The edge then normalizes the body into canonical
// payout events; each settled or failed event is bridged onto the matching
// saga and persisted to the inbox for drainInbox to apply. KYC and
// unrecognized events are acknowledged and skipped — the payee gate reads
// live status, so nothing is lost. The dedupe key is the event's status
// transition (see payoutEventIdOf), so redelivery dedupes however the rail
// re-serializes the callback.
export function tiliaWebhook(
  edge: Pick<EdgeTiliaCapabilities, 'outbound' | 'verifyWebhook'>,
  store: Store,
  ctx: { ids: Ids; clock: Clock },
): WebhookHandler {
  const lookup = sagaByProviderRef(store);
  return async (_provider, request) => {
    const webhook = {
      provider: 'tilia',
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    } as const;
    if (!(await edge.verifyWebhook(webhook))) {
      return new Response(JSON.stringify({ status: 'refused' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const events = edge.outbound.parse(webhook);
    let applied = 0;
    let skipped = 0;
    for (const event of events) {
      const eventId = payoutEventIdOf(event);
      const mapped =
        eventId === null
          ? null
          : await edgePayoutWebhookEvent(event, { eventId }, lookup);
      if (mapped === null) {
        skipped += 1;
        continue;
      }
      await handleWebhook(store, ctx, mapped);
      applied += 1;
    }
    return new Response(
      JSON.stringify({ status: 'accepted', applied, skipped }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}
