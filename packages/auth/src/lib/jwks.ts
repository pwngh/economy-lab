/**
 * @pwngh/economy-auth
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { fromBase64Url } from '@pwngh/economy-lab/store-kit';
import { userActor } from './identity.js';
import type { Authenticate, Principal } from './identity.js';
import { bearerOf } from './bearer.js';

export interface JwksOptions {
  readonly issuer?: string;
  readonly audience?: string;
  /** Claims → Principal; default maps `sub` to a user actor. Return null to refuse. */
  readonly principal?: (claims: Record<string, unknown>) => Principal | null;
  /** JWKS cache lifetime; default 300_000 ms. `0` refetches on every verification. */
  readonly cacheMs?: number;
  /** Accepted clock skew on `exp` and `nbf`; default 0 — the times are exact. */
  readonly clockToleranceMs?: number;
  readonly fetch?: typeof fetch;
}

// A JWKS answer larger than this is refused as malformed — no sane IdP is close.
const MAX_JWKS_KEYS = 100;

const ALGS: Record<
  string,
  {
    imp: RsaHashedImportParams | EcKeyImportParams | { name: string };
    ver: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  }
> = {
  RS256: {
    imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    ver: 'RSASSA-PKCS1-v1_5',
  },
  ES256: {
    imp: { name: 'ECDSA', namedCurve: 'P-256' },
    ver: { name: 'ECDSA', hash: 'SHA-256' },
  },
  EdDSA: { imp: { name: 'Ed25519' }, ver: 'Ed25519' },
};

/** A millisecond window. NaN would never satisfy a comparison, silently disabling the gate
 *  it measures, so the misconfiguration is refused where it is written. */
const windowOption = (
  name: string,
  value: number | undefined,
  fallback: number,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `authJwks: ${name} must be a finite count of milliseconds, not ${value}`,
    );
  }
  return value;
};

/** A claim to match. `undefined` is how a caller declines the check; a blank string is a
 *  missing value, and reading it as "check nothing" accepts every issuer there is. */
const claimOption = (
  name: string,
  value: string | undefined,
): string | undefined => {
  if (value === '')
    throw new TypeError(
      `authJwks: ${name} is blank — omit it to check nothing`,
    );
  return value;
};

/**
 * Verifies `Authorization: Bearer <jwt>` against the keys at a JWKS URL — fetch plus
 * WebCrypto, no dependencies. RS256, ES256, and EdDSA; exp and nbf always checked (exact
 * by default, `clockToleranceMs` widens both edges); iss and aud checked when configured.
 * Anything malformed, unverified, or expired resolves null.
 */
export function authJwks(url: string, options: JwksOptions = {}): Authenticate {
  const doFetch = options.fetch ?? fetch;
  const cacheMs = windowOption('cacheMs', options.cacheMs, 300_000);
  const skew =
    windowOption('clockToleranceMs', options.clockToleranceMs, 0) / 1000;
  const issuer = claimOption('issuer', options.issuer);
  const audience = claimOption('audience', options.audience);
  const toPrincipal =
    options.principal ??
    ((claims: Record<string, unknown>) =>
      typeof claims.sub === 'string' && claims.sub
        ? userActor(claims.sub)
        : null);
  let keys: {
    kid?: string;
    alg?: string;
    use?: string;
    [k: string]: unknown;
  }[] = [];
  let fetchedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  // One fetch per cache window, shared by every verification in flight — a down IdP never
  // sees a request herd. A bad answer (transport error, non-JSON, an oversized key set)
  // keeps the cached keys serving; only a well-formed answer replaces them.
  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      fetchedAt = Date.now();
      try {
        const res = await doFetch(url);
        if (!res.ok) return;
        const set = ((await res.json()) as { keys?: typeof keys }).keys;
        if (Array.isArray(set) && set.length <= MAX_JWKS_KEYS) keys = set;
      } catch {
        /* the cached set keeps serving */
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  // complexity 26: one token-verification path, each claim checked in sequence.
  // eslint-disable-next-line complexity
  return async (request) => {
    try {
      const token = bearerOf(request);
      if (!token) return null;
      // A JWS is exactly three segments. Reading the first three of a longer string would
      // accept an unbounded family of spellings of one credential.
      const segments = token.split('.');
      if (segments.length !== 3) return null;
      const [h, p, s] = segments as [string, string, string];
      if (!h || !p || !s) return null;
      const header = JSON.parse(new TextDecoder().decode(fromBase64Url(h)));
      const alg = ALGS[header.alg as string];
      if (!alg) return null;

      if (inflight !== null) await inflight;
      else if (Date.now() - fetchedAt >= cacheMs) await refresh();
      // The key must agree with the token: no signing with an encryption key, no alg swap.
      const usable = (k: (typeof keys)[number]) =>
        (k.use === undefined || k.use === 'sig') &&
        (k.alg === undefined || k.alg === header.alg);
      const pick = () =>
        keys.find(
          (k) => (header.kid ? k.kid === header.kid : true) && usable(k),
        );
      let jwk = pick();
      if (!jwk && header.kid && Date.now() - fetchedAt > 30_000) {
        await refresh(); // an unknown kid is what rotation looks like — one immediate retry
        jwk = pick();
      }
      if (!jwk) return null;

      const key = await crypto.subtle.importKey(
        'jwk',
        jwk as JsonWebKey,
        alg.imp,
        false,
        ['verify'],
      );
      const ok = await crypto.subtle.verify(
        alg.ver,
        key,
        fromBase64Url(s) as BufferSource,
        new TextEncoder().encode(`${h}.${p}`),
      );
      if (!ok) return null;

      const claims = JSON.parse(
        new TextDecoder().decode(fromBase64Url(p)),
      ) as Record<string, unknown>;
      const now = Date.now() / 1000;
      if (typeof claims.exp !== 'number' || claims.exp <= now - skew)
        return null;
      // A present nbf must be a number to be checked at all; a string one is malformed,
      // not absent, and skipping it would leave the not-before window unenforced.
      if (
        claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' || claims.nbf > now + skew)
      )
        return null;
      if (issuer !== undefined && claims.iss !== issuer) return null;
      if (
        audience !== undefined &&
        claims.aud !== audience &&
        !(Array.isArray(claims.aud) && claims.aud.includes(audience))
      )
        return null;
      return toPrincipal(claims);
    } catch {
      return null;
    }
  };
}
