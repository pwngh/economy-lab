// noinspection JSUnusedGlobalSymbols

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
 * Globals the core library may use. The build pulls in no DOM and no Node types, so these must
 * be declared, and only the subset present on every modern runtime (Node 22+, Bun, Deno,
 * Cloudflare Workers) is declared — keeping Node-only globals out of the core. Adapters that
 * need a Node API import from `node:*`, which lint permits only there.
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

// Part of the WinterCG Minimum Common API, so it belongs to this cross-runtime subset.
declare function btoa(data: string): string;

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

// Only the JWK fields the signer touches. The keys are Ed25519: `x` is the public coordinate,
// `d` the private one.
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
