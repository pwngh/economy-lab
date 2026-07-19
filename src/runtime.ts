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
import { sha256Digest } from '#src/digest.ts';

import type {
  Clock,
  Digest,
  Ids,
  IdPrefix,
  Logger,
  Meter,
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
 * Production hasher. Returns the shared SHA-256 {@link Digest} ({@link sha256Digest}): a synchronous
 * node:crypto hash where the runtime offers one, else Web Crypto. The same bytes hash to the same
 * value on every runtime, so a signed checkpoint re-derives wherever it is verified.
 */
export function systemDigest(): Digest {
  return sha256Digest();
}

// Fixed PKCS#8 DER header for an Ed25519 private key. The 32-byte seed is appended after it.
// WebCrypto imports Ed25519 private keys in PKCS#8 form, so a bare seed must be wrapped in this
// header first.
const ED25519_PKCS8_HEADER = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

// Derives a deterministic Ed25519 key pair from secret key material. The secret may be any
// length; it is hashed with SHA-256 to a 32-byte seed for the private key, and the public key is
// recovered from the private key's JWK. The same secret always yields the same pair. This lets
// checkpoints verify reproducibly and lets the public key be published for an external auditor.
async function ed25519KeyPair(
  secret: string,
): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const seed = new Uint8Array(
    await crypto.subtle.digest('SHA-256', fromHex(secret)),
  );
  const pkcs8 = new Uint8Array(ED25519_PKCS8_HEADER.length + seed.length);
  pkcs8.set(ED25519_PKCS8_HEADER, 0);
  pkcs8.set(seed, ED25519_PKCS8_HEADER.length);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
  return { privateKey, publicKey };
}

/**
 * Production signer. Signs bytes with Ed25519 so an auditor can confirm a checkpoint wasn't
 * rewritten using only the published public key.
 *
 * `sign` always uses the current key. `verify` accepts a signature from the current key or any
 * prior key passed in, so a checkpoint signed under the old key still verifies across a key
 * rotation.
 *
 * Both work on raw bytes. Hex encoding of keys and stored signatures happens at the storage
 * boundary, not here.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/signer/ Signer} for the signing and
 *   key-rotation contract.
 */
export function systemSigner(options: {
  signingKey: string;
  priorKeys?: ReadonlyArray<string>;
}): Signer {
  const current = ed25519KeyPair(options.signingKey);
  const verifiers = [
    current.then((pair) => pair.publicKey),
    ...(options.priorKeys ?? []).map((k) =>
      ed25519KeyPair(k).then((pair) => pair.publicKey),
    ),
  ];
  const kid = current
    .then((pair) => crypto.subtle.exportKey('raw', pair.publicKey))
    .then((raw) => toHex(new Uint8Array(raw)).slice(0, 16));

  return {
    kid: async () => kid,
    sign: async (bytes) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          (await current).privateKey,
          bytes,
        ),
      ),
    verify: async (bytes, signature) => {
      for (const publicKey of verifiers) {
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
 * Hex-encoded raw 32-byte Ed25519 public key derived from `signingKey`. Publish it so an external
 * party can verify signed checkpoints without the signing secret.
 */
export async function signingPublicKeyHex(signingKey: string): Promise<string> {
  const { publicKey } = await ed25519KeyPair(signingKey);
  return toHex(new Uint8Array(await crypto.subtle.exportKey('raw', publicKey)));
}

/**
 * Bundles the four capabilities (clock, id generator, hasher, signer) into one
 * object for a production host to wire in.
 *
 * `signingKey` and any `priorKeys` are hex-encoded secret key bytes the host
 * loads from its own config and passes in; this module never reads them from a
 * global or the environment.
 */
export function systemRuntime(options: {
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
 * Structured logger for production hosts. Each call writes one JSONL object,
 * shaped `{ts, level, service, event, ...fields}`, for log collectors to parse
 * line by line. By default every level writes to stderr (info, debug, and warn
 * via `console.warn`; error via `console.error`); supply `out` and `err` to
 * route the two separately. Implements the same `Logger` interface as the
 * no-op default, so a host can swap it in directly.
 *
 * Supply `now` (epoch ms) so a test can freeze the timestamp and check the exact
 * line; it defaults to wall-clock time. `service` names the emitting process and
 * appears on every line.
 */
export function jsonlLogger(
  options: {
    service?: string;
    now?: () => number;
    out?: (line: string) => void;
    err?: (line: string) => void;
  } = {},
): Logger {
  const service = options.service ?? 'economy-lab';
  const now = options.now ?? (() => Date.now());
  const out = options.out ?? ((line) => console.warn(line));
  const err = options.err ?? ((line) => console.error(line));
  return {
    log: (level, event, fields) => {
      const sink = level === 'error' ? err : out;
      sink(JSON.stringify({ ts: now(), level, service, event, ...fields }));
    },
  };
}

/** A Logger that discards every line: the silent default for a host that wants no log output. */
export function silentLogger(): Logger {
  return { log: () => {} };
}

/** A Meter that discards every count and observation: the default when a host collects no metrics. */
export function silentMeter(): Meter {
  return { count: () => {}, observe: () => {} };
}

// Re-export toHex so chain/checkpoint writers can store raw signatures as hex
// without importing bytes.ts separately.
export { toHex };
