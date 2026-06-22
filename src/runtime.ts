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

import { fromHex, toHex } from '#src/bytes.ts';

import type {
  Clock,
  Digest,
  Ids,
  IdPrefix,
  Logger,
  Signer,
} from '#src/ports.ts';

/**
 * Production clock reading wall-clock time. Time is read only through a clock,
 * never `Date.now` directly elsewhere, so tests can swap in a fake.
 */
export function systemClock(): Clock {
  return { now: () => Date.now() };
}

/**
 * Fake clock for tests. Frozen at `start` (epoch ms); only `advance(ms)` moves
 * it forward, returning the new time. Keeps test outcomes repeatable.
 */
export function fixedClock(
  start = 0,
): Clock & { advance: (ms: number) => number } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
  };
}

/**
 * Production id generator. Each id is `prefix_<random UUID>` (e.g. `txn_3f2a...`),
 * so ids are effectively unique without cross-machine coordination.
 */
export function randomIds(): Ids {
  return { next: (prefix: IdPrefix) => `${prefix}_${crypto.randomUUID()}` };
}

/**
 * Predictable id generator for tests. Counts up from `seed` (`prefix_1`,
 * `prefix_2`, ...), so a test produces the same ids every run.
 */
export function sequentialIds(seed = 0): Ids {
  let n = seed;
  return {
    next: (prefix: IdPrefix) => {
      n += 1;
      return `${prefix}_${n}`;
    },
  };
}

/**
 * Production hasher. Returns the SHA-256 of the input bytes via platform web
 * crypto; the same bytes hash to the same value on every runtime.
 */
export function systemDigest(): Digest {
  return {
    hash: async (bytes) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  };
}

// Fixed PKCS#8 DER header for an Ed25519 private key, followed by the 32-byte seed. WebCrypto
// imports Ed25519 private keys in PKCS#8 form, so a bare seed gets wrapped in this header.
let ED25519_PKCS8_HEADER = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

// Derive a deterministic Ed25519 key pair from secret key material. The secret (any length) is
// SHA-256'd to a 32-byte seed and imported as the private (signing) key; the public (verifying)
// key is recovered by exporting the private key's JWK and re-importing just its public coordinate.
// The same secret always yields the same pair, so checkpoints verify reproducibly, and the public
// key can be published so an external auditor can verify a checkpoint without the secret.
async function ed25519KeyPair(
  secret: string,
): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  let seed = new Uint8Array(
    await crypto.subtle.digest('SHA-256', fromHex(secret)),
  );
  let pkcs8 = new Uint8Array(ED25519_PKCS8_HEADER.length + seed.length);
  pkcs8.set(ED25519_PKCS8_HEADER, 0);
  pkcs8.set(seed, ED25519_PKCS8_HEADER.length);
  let privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  let jwk = await crypto.subtle.exportKey('jwk', privateKey);
  let publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
  return { privateKey, publicKey };
}

/**
 * The real signer for production. It signs bytes with Ed25519 (asymmetric): the secret derives a
 * private key that produces 64-byte signatures, and the matching public key verifies them — so an
 * external auditor can confirm a checkpoint was not rewritten using only the published public key,
 * never the signing secret.
 *
 * `sign` always uses the current key. `verify` accepts a signature made by the current key OR by
 * any of the prior keys passed in, so when the signing key is rotated a checkpoint signed under the
 * old key still verifies during the changeover instead of suddenly being rejected.
 *
 * `sign` and `verify` work on raw bytes. Turning keys and stored signatures into hex text, and
 * back, happens where the data is read from or written to storage, not here.
 */
export function systemSigner(options: {
  signingKey: string;
  priorKeys?: ReadonlyArray<string>;
}): Signer {
  let current = ed25519KeyPair(options.signingKey);
  let verifiers = [
    current.then((pair) => pair.publicKey),
    ...(options.priorKeys ?? []).map((k) =>
      ed25519KeyPair(k).then((pair) => pair.publicKey),
    ),
  ];

  return {
    sign: async (bytes) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          (await current).privateKey,
          bytes,
        ),
      ),
    verify: async (bytes, signature) => {
      for (let publicKey of verifiers) {
        if (
          await crypto.subtle.verify(
            { name: 'Ed25519' },
            await publicKey,
            signature,
            bytes,
          )
        ) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * The hex-encoded Ed25519 public key derived from `signingKey` — publish this so an external party
 * can verify the signed checkpoints without holding the signing secret. Returns the raw 32-byte
 * public key as hex.
 */
export async function signingPublicKeyHex(signingKey: string): Promise<string> {
  let { publicKey } = await ed25519KeyPair(signingKey);
  return toHex(new Uint8Array(await crypto.subtle.exportKey('raw', publicKey)));
}

/**
 * Bundles the four real capabilities — clock, id generator, hasher, and signer —
 * into one object for a production host to wire into the rest of the system.
 *
 * `signingKey` (and any `priorKeys`) are hex-encoded secret key bytes that the
 * host loads from its own configuration and passes in here; this module never
 * reads them from a global or the environment.
 */
export function systemCapabilities(options: {
  signingKey: string;
  priorKeys?: ReadonlyArray<string>;
}): { clock: Clock; ids: Ids; digest: Digest; signer: Signer } {
  return {
    clock: systemClock(),
    ids: randomIds(),
    digest: systemDigest(),
    signer: systemSigner(options),
  };
}

/**
 * A structured logger for production hosts. Each call writes exactly one JSON
 * object on its own line — the format log collectors parse line by line — shaped
 * `{ts, level, service, event, ...fields}`. info/debug/warn lines go to stdout
 * (via `console.warn`) and error lines go to stderr (via `console.error`). It
 * implements the same `Logger` interface as the do-nothing default logger, so a
 * host can swap this in wherever that default was wired without other changes.
 *
 * The timestamp source can be supplied (`now`, in epoch milliseconds) so a test
 * can freeze it and check the exact line; it defaults to the current wall-clock
 * time. The `service` tag names the emitting process and appears on every line.
 */
export function jsonlLogger(
  options: {
    service?: string;
    now?: () => number;
    out?: (line: string) => void;
    err?: (line: string) => void;
  } = {},
): Logger {
  let service = options.service ?? 'economy-lab';
  let now = options.now ?? (() => Date.now());
  let out = options.out ?? ((line) => console.warn(line));
  let err = options.err ?? ((line) => console.error(line));
  return {
    log: (level, event, fields) => {
      let sink = level === 'error' ? err : out;
      sink(JSON.stringify({ ts: now(), level, service, event, ...fields }));
    },
  };
}

// Re-export the bytes-to-hex helper so the code that writes chains and
// checkpoints can store raw signatures as hex text without importing bytes.ts
// separately.
export { toHex };
