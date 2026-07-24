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

import { toHex } from '#src/bytes.ts';
import {
  isProduction,
  readBigIntOrNull,
  readIntOrNull,
  serviceUrls,
} from '#src/env.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { configuredRates } from '#src/adapters/rates.ts';
import { httpProcessor, memoryProcessor } from '#src/adapters/processor.ts';
import { flatFee } from '#src/pricing.ts';
import { systemSigner } from '#src/runtime.ts';

import type { EnvMap } from '#src/env.ts';
import type { Secrets } from '#src/config.ts';
import type { FeePolicy } from '#src/contract.ts';
import type { Processor, Rates, Signer } from '#src/ports.ts';

// The external ports have no built-in production stand-in, so openPorts resolves them here: each
// falls back to a safe dev default outside production, and in production is required from the
// environment, failing fast with one message that lists everything missing.

const ENCODER = new TextEncoder();
const DEV_SIGNING_SECRET = 'dev-signing-secret';

/**
 * The dev rate table `openPorts` and `memoryPorts` wire outside production: buy ~$0.00833 per
 * credit, backing peg and cash-out $0.005. Public so a host or console that displays or re-mints
 * the dev rates shares this one definition; production rates come from env or the init.
 */
export const DEV_RATES: RatesConfig = {
  buyRate: 8333n,
  buyScale: 6,
  parRate: 5n,
  parScale: 3,
  payoutRate: 5n,
  payoutScale: 3,
};

/**
 * The exact integer knobs `configuredRates` takes; accepted anywhere a Rates instance is (a
 * PortsInit `rates` field, for one). Each pair states one CREDIT-to-USD rate as rate / 10^scale
 * USD per credit — exact integers, never a float. Construction refuses a table whose buy rate
 * sits below par, since every top-up would then book a loss.
 */
export type RatesConfig = {
  /** What a buyer pays per credit: buyRate / 10^buyScale USD. */
  readonly buyRate: bigint;
  readonly buyScale: number;
  /** The backing peg: the USD per credit the trust must hold against custodial balances. */
  readonly parRate: bigint;
  readonly parScale: number;
  /** The cash-out rate: the USD per credit a payout settles at. */
  readonly payoutRate: bigint;
  readonly payoutScale: number;
};

// What openPorts may override the env-derived externals with (a slice of PortsInit).
export type ExternalInit = {
  signer?: Signer;
  processor?: Processor;
  rates?: Rates | RatesConfig;
  pricing?: FeePolicy;
};

export type Externals = {
  signer: Signer;
  processor: Processor;
  rates: Rates;
  pricing: FeePolicy;
};

/**
 * The env keys production requires but that are missing or malformed — the six CREDIT-to-USD
 * rate knobs and the payout provider URL — skipping any family the init already supplies.
 * Empty outside production. The single source `preflight` reports and `openPorts` throws on.
 */
export function missingExternals(
  env: EnvMap,
  init: ExternalInit = {},
): string[] {
  if (!isProduction(env)) {
    return [];
  }
  const missing: string[] = [];
  if (init.rates === undefined) {
    for (const key of ['CREDIT_BUY_RATE', 'CREDIT_PAR_RATE', 'PAYOUT_RATE']) {
      if (readBigIntOrNull(env[key]) === null) {
        missing.push(key);
      }
    }
    for (const key of [
      'CREDIT_BUY_SCALE',
      'CREDIT_PAR_SCALE',
      'PAYOUT_SCALE',
    ]) {
      if (readIntOrNull(env[key]) === null) {
        missing.push(key);
      }
    }
  }
  if (init.processor === undefined && serviceUrls(env).processor === null) {
    missing.push('PROCESSOR_URL');
  }
  return missing;
}

/**
 * Refuses a malformed port at wiring time, so the deploy fails at startup rather than deep
 * inside a request or sweep. The classic slip is passing a factory (`silentLogger`) where its
 * product (`silentLogger()`) belongs.
 */
export function requireCallable(
  owner: string,
  service: unknown,
  methods: ReadonlyArray<string>,
): void {
  for (const method of methods) {
    if (typeof (service as Record<string, unknown>)?.[method] !== 'function') {
      throw fault(
        ERROR_CODES.CONFIG_INVALID,
        `${owner}.${method} is not a function; if it comes from a factory such as silentLogger, pass the factory's result.`,
        { detail: { owner, method }, retryable: false },
      );
    }
  }
}

/**
 * Resolves the external ports from `env` and `secrets`, letting the init win over anything
 * derived. Dev fills sane defaults; production requires the real values for the ports not
 * overridden and throws `CONFIG.INVALID` listing every missing knob at once.
 */
export function resolveExternals(
  env: EnvMap,
  init: ExternalInit,
  secrets: Secrets,
): Externals {
  const missing = missingExternals(env, init);
  if (missing.length > 0) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      `NODE_ENV=production requires real externals; missing or malformed: ${missing.join(', ')}. ` +
        'Set the CREDIT-to-USD rates and the payout provider.',
      { detail: { missing }, retryable: false },
    );
  }
  const externals: Externals = {
    signer: init.signer ?? signerFromSecrets(secrets),
    rates: resolveRates(env, init.rates),
    processor: init.processor ?? processorFor(env),
    pricing: init.pricing ?? flatFee(),
  };
  requireCallable('signer', externals.signer, ['sign', 'verify']);
  requireCallable('rates', externals.rates, ['payout']);
  requireCallable('processor', externals.processor, ['submitPayout']);
  requireCallable('externals', externals, ['pricing']);
  return externals;
}

/**
 * The Ed25519 signer the secrets bag names: the signing secret hashed to a seed, each rotated-out
 * prior transformed the same way so checkpoints sealed under one still verify. A blank secret
 * (dev only — production refuses it upstream) falls back to a fixed non-secret.
 */
export function signerFromSecrets(secrets: Secrets): Signer {
  const priors = (secrets.signingSecretsPrior ?? []).map((secret) =>
    toHex(ENCODER.encode(secret)),
  );
  return systemSigner({
    signingKey: signingKey(secrets.signingSecret),
    ...(priors.length > 0 ? { priorKeys: priors } : {}),
  });
}

function signingKey(secret: string): string {
  return toHex(ENCODER.encode(secret === '' ? DEV_SIGNING_SECRET : secret));
}

// A RatesConfig is told apart from a live Rates source by its callable `payout`.
function resolveRates(
  env: EnvMap,
  rates: Rates | RatesConfig | undefined,
): Rates {
  if (rates !== undefined) {
    return typeof (rates as Rates).payout === 'function'
      ? (rates as Rates)
      : configuredRates(rates as RatesConfig);
  }
  if (!isProduction(env)) {
    return configuredRates(DEV_RATES);
  }
  // Production: the six knobs were validated present by the missing check above.
  return configuredRates({
    buyRate: readBigIntOrNull(env.CREDIT_BUY_RATE) ?? 0n,
    buyScale: readIntOrNull(env.CREDIT_BUY_SCALE) ?? 0,
    parRate: readBigIntOrNull(env.CREDIT_PAR_RATE) ?? 0n,
    parScale: readIntOrNull(env.CREDIT_PAR_SCALE) ?? 0,
    payoutRate: readBigIntOrNull(env.PAYOUT_RATE) ?? 0n,
    payoutScale: readIntOrNull(env.PAYOUT_SCALE) ?? 0,
  });
}

function processorFor(env: EnvMap): Processor {
  const url = serviceUrls(env).processor;
  if (url !== null) {
    return httpProcessor({ endpoint: url, apiKey: env.PROCESSOR_API_KEY });
  }
  // No provider URL: the in-memory processor. Production reports the absence as missing, above.
  return memoryProcessor();
}
