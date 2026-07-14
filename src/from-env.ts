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
import type { FeePolicy } from '#src/contract.ts';
import type { Processor, Rates, Signer } from '#src/ports.ts';

// The four external ports have no built-in production stand-in, so createEconomy resolves them here:
// each falls back to a safe dev default outside production, and in production is required from the
// environment, failing fast with one message that lists everything missing. This is the wiring the
// reference host used to hand-roll; the library owns it now, so every consumer gets the same rules.

const ENCODER = new TextEncoder();
const DEV_SIGNING_SECRET = 'dev-signing-secret';

// Dev rates through the production constructor, so dev and production run the same rate code and
// differ only in where the numbers come from: buy ~$0.00833/credit, backing peg and cash-out $0.005.
const DEV_RATES = {
  buyRate: 8333n,
  buyScale: 6,
  parRate: 5n,
  parScale: 3,
  payoutRate: 5n,
  payoutScale: 3,
} as const;

export type Externals = {
  signer: Signer;
  processor: Processor;
  rates: Rates;
  pricing: FeePolicy;
};

/**
 * The env keys production requires but that are missing or malformed: the signing secret, the six
 * CREDIT-to-USD rate knobs, and the payout provider URL. Empty outside production and when every
 * value is present. The single source {@link externalsFromEnv} throws on and `checkEnv` reports.
 */
export function missingExternals(env: EnvMap): string[] {
  if (!isProduction(env)) {
    return [];
  }
  const missing: string[] = [];
  if ((env.SIGNING_SECRET ?? '') === '') {
    missing.push('SIGNING_SECRET');
  }
  for (const key of ['CREDIT_BUY_RATE', 'CREDIT_PAR_RATE', 'PAYOUT_RATE']) {
    if (readBigIntOrNull(env[key]) === null) {
      missing.push(key);
    }
  }
  for (const key of ['CREDIT_BUY_SCALE', 'CREDIT_PAR_SCALE', 'PAYOUT_SCALE']) {
    if (readIntOrNull(env[key]) === null) {
      missing.push(key);
    }
  }
  if (serviceUrls(env).processor === null) {
    missing.push('PROCESSOR_URL');
  }
  return missing;
}

// A missing key still matters only if an override does not already supply that port.
function stillRequired(key: string, overrides: Partial<Externals>): boolean {
  if (key === 'SIGNING_SECRET') return overrides.signer === undefined;
  if (key === 'PROCESSOR_URL') return overrides.processor === undefined;
  return overrides.rates === undefined; // the six rate knobs
}

/**
 * Resolves the four external ports from `env`, letting `overrides` win over anything derived. Dev
 * fills sane defaults; production requires the real values for the ports not overridden and throws
 * `CONFIG.INVALID` listing every missing knob at once.
 */
export function externalsFromEnv(
  env: EnvMap,
  overrides: Partial<Externals> = {},
): Externals {
  const missing = missingExternals(env).filter((key) =>
    stillRequired(key, overrides),
  );
  if (missing.length > 0) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      `NODE_ENV=production requires real externals; missing or malformed: ${missing.join(', ')}. ` +
        'Set the CREDIT-to-USD rates, the payout provider, and the signing secret.',
      { detail: { missing }, retryable: false },
    );
  }
  return {
    signer: overrides.signer ?? systemSigner({ signingKey: signingKey(env) }),
    rates: overrides.rates ?? rateSource(env),
    processor: overrides.processor ?? processorFor(env),
    pricing: overrides.pricing ?? flatFee(),
  };
}

// The signer's key is the SIGNING_SECRET hashed to a seed; dev falls back to a fixed non-secret.
function signingKey(env: EnvMap): string {
  const secret = env.SIGNING_SECRET ?? '';
  return toHex(ENCODER.encode(secret === '' ? DEV_SIGNING_SECRET : secret));
}

// Dev uses the fixed DEV_RATES; production reads the six knobs (already validated present by the
// missing check that runs before this).
function rateSource(env: EnvMap): Rates {
  if (!isProduction(env)) {
    return configuredRates(DEV_RATES);
  }
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
