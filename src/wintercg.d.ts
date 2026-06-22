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

/**
 * Type declarations for the small set of global APIs the core library is allowed
 * to use — only the ones that exist on every modern JavaScript runtime
 * (Node 22+, Bun, Deno, Cloudflare Workers). The build is configured with no DOM
 * types and no Node types, so without this file these globals would be unknown to
 * the type checker. Declaring exactly this subset here means a Node-only global can
 * never slip into the core by accident. Adapter code that genuinely needs Node APIs
 * imports them from `node:*` directly, which the lint rules permit only there.
 */

// --- Bytes / text -----------------------------------------------------------------

interface TextEncoder {
  encode(input?: string): Uint8Array;
}
declare let TextEncoder: { new (): TextEncoder };

interface TextDecoder {
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
declare let TextDecoder: { new (label?: string): TextDecoder };

declare function structuredClone<T>(value: T): T;
declare function queueMicrotask(callback: () => void): void;

// --- Cancellation -----------------------------------------------------------------

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
declare let AbortSignal: {
  new (): AbortSignal;
  abort(reason?: unknown): AbortSignal;
  timeout(ms: number): AbortSignal;
  any(signals: Iterable<AbortSignal>): AbortSignal;
};

interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
declare let AbortController: { new (): AbortController };

// --- Web Crypto -------------------------------------------------------------------

type KeyUsage =
  | 'sign'
  | 'verify'
  | 'encrypt'
  | 'decrypt'
  | 'deriveKey'
  | 'deriveBits'
  | 'wrapKey'
  | 'unwrapKey';
type KeyFormat = 'raw' | 'pkcs8' | 'spki' | 'jwk';

interface CryptoKey {
  readonly type: string;
  readonly extractable: boolean;
  readonly usages: ReadonlyArray<KeyUsage>;
}

type BufferSource = ArrayBufferView | ArrayBuffer;

// The subset of JWK fields this codebase reads/writes (Ed25519 keys: `x` is the public
// coordinate, `d` the private). A full JWK has more, but these are all the signer touches.
interface JsonWebKey {
  kty?: string;
  crv?: string;
  x?: string;
  d?: string;
}

interface SubtleCrypto {
  digest(
    algorithm: string | { name: string },
    data: BufferSource,
  ): Promise<ArrayBuffer>;
  sign(
    algorithm: string | { name: string },
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
  verify(
    algorithm: string | { name: string },
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource,
  ): Promise<boolean>;
  importKey(
    format: 'jwk',
    keyData: JsonWebKey,
    algorithm: string | { name: string; hash?: string },
    extractable: boolean,
    keyUsages: ReadonlyArray<KeyUsage>,
  ): Promise<CryptoKey>;
  importKey(
    format: KeyFormat,
    keyData: BufferSource,
    algorithm: string | { name: string; hash?: string },
    extractable: boolean,
    keyUsages: ReadonlyArray<KeyUsage>,
  ): Promise<CryptoKey>;
  exportKey(format: 'jwk', key: CryptoKey): Promise<JsonWebKey>;
  exportKey(
    format: 'raw' | 'pkcs8' | 'spki',
    key: CryptoKey,
  ): Promise<ArrayBuffer>;
}

interface Crypto {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID(): string;
}

declare let crypto: Crypto;
