/**
 * @pwngh/economy-receipt
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import {
  decodeTextBase64Url,
  encodeTextBase64Url,
  keyId,
  sign as signValue,
  unsign as unsignValue,
} from './receipt-signing.js';

/**
 * One account's step in the ledger's hash chain, as the posting recorded it.
 *
 * This is the whole reason a receipt is more than a signed blob. The ledger hashes each
 * posting into a per-account chain: `prevHash` is that account's head before the posting and
 * `hash` is its head after. Matching the link against the ledger settles that the posting
 * committed and how that account's history ran through it, which no signature can say.
 *
 * Structurally the same as the lab's `ChainLink` and one entry of `Transaction.links`.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for the
 *   chain construction this link comes from.
 */
export interface ReceiptLink {
  /** The account whose chain advanced, such as `usr_4c1d9e:spendable`. */
  account: string;

  /**
   * That account's head hash before the posting, 64 lowercase hex characters. An account's
   * first posting carries the genesis value, 64 zeros.
   */
  prevHash: string;

  /** That account's head hash after the posting, 64 lowercase hex characters. */
  hash: string;
}

/**
 * One debit or credit line of the posting, for the support desk rather than the machine.
 *
 * Amounts are debit-positive — the ledger's sign, not the account holder's, so a top-up's
 * wallet leg reads negative. Converting a leg to the change in that account's balance needs to
 * know which accounts are debit-normal, which is the lab's `balanceDelta` from `/store-kit`,
 * not this package's.
 */
export interface ReceiptLeg {
  account: string;

  /** The line's amount in the canonical wire form, such as `CREDIT:-600.00`. */
  amount: string;
}

/**
 * The receipt payload: what a client can prove about one committed transaction.
 *
 * The fields track the ledger's `Transaction` — `txnId` is its `id`, `issuedAt` is its
 * `postedAt`, `link` is its entry in `links` for the account this receipt is about, and
 * `amount` is the wire form `encodeAmount` writes. Everything here is plain JSON, so a receipt
 * survives any transport and reading one never loads the economy.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/money-model/ The money model}
 *   for the minor-unit design behind the wire amount.
 */
export interface Receipt {
  /** The committed posting this receipt stands for, of the form `txn_<uuid>`. */
  txnId: string;

  /** The actor the transaction belongs to: who may present this receipt as theirs. */
  userId: string;

  /**
   * The money that moved, in the canonical wire form `<CURRENCY>:<decimal>` — `CREDIT` or `USD`,
   * exactly two decimal places, no digit grouping, as in `CREDIT:600.00` or `USD:100.00`.
   *
   * Any other currency, any other spelling of the same number, or a magnitude past the 64-bit
   * minor-unit range the ledger stores leaves the receipt unverifiable.
   */
  amount: string;

  /** When the transaction committed, in epoch milliseconds. `ttlMs` is measured from here. */
  issuedAt: number;

  /** The posting's place in the ledger's hash chain. See {@link ReceiptLink}. */
  link: ReceiptLink;

  /** The posting's individual lines, when the issuer includes them. See {@link ReceiptLeg}. */
  legs?: ReceiptLeg[];

  /** The operation that posted it, such as `topUp` or `requestPayout`, when the issuer records one. */
  kind?: string;
}

/**
 * The part of a committed transaction {@link Receipts.verifyAgainst} reads.
 *
 * Declared structurally rather than imported so this package keeps no dependency on the lab
 * and still runs at the edge. The lab's `Transaction` satisfies it as-is: pass one straight
 * from `read.transaction(id)`.
 */
export interface LedgerTransaction {
  /** The posting's id, of the form `txn_<uuid>`. */
  id: string;

  /** How each touched account's chain advanced, one entry per account. */
  links: ReadonlyArray<{ account: string; prevHash: string; hash: string }>;
}

/**
 * Options for creating a receipt codec.
 */
export interface ReceiptsOptions {
  /**
   * A function that decodes the payload, reading back whatever `encode` wrote.
   *
   * Throwing here is a verification failure like any other: `verify` returns `null`.
   *
   * @default The default decoder reverses the default base64url payload encoder.
   */
  decode?: (encoded: string) => Receipt;

  /**
   * A function that encodes the payload into the text that gets signed.
   *
   * Custom encoders are the whole payload codec: their return value is signed and placed in
   * the receipt as-is, without the default base64url wrapper, so it must hold only characters
   * that are safe wherever the receipts travel.
   *
   * @default The default encoder wraps the payload's JSON in base64url.
   */
  encode?: (payload: Receipt) => string;

  /**
   * The secrets a receipt may be signed and verified under, newest first.
   *
   * `sign` always uses the first entry. `verify` selects by the key id stamped on the receipt,
   * so rotation is a prepend: put the new secret at the front and every receipt already in a
   * client's hands still names, and still finds, the secret behind it.
   *
   * At least one secret is required. An unsigned receipt is not tamper-evident, so there is
   * no unsigned mode.
   */
  secrets: string[];

  /**
   * How long a receipt stays valid, in milliseconds after its `issuedAt`. Omit for receipts
   * that never expire.
   *
   * The window is checked only after the signature is, so the `issuedAt` it reads is one the
   * issuer signed rather than one the holder supplied.
   */
  ttlMs?: number;
}

type Decoder = (encoded: string) => Receipt;
type Encoder = (payload: Receipt) => string;
type Keyring = ReadonlyArray<{ kid: string; secret: string }>;

/** Names the format and its version. It sits inside the signed bytes, so it cannot be swapped. */
const SCHEME = 'rcpt1';

/**
 * The wire form `encodeAmount` writes: one of the two currencies the ledger mints, a colon, and
 * an ungrouped two-decimal number carrying no leading zero.
 *
 * The currency names are spelled here because this package takes no dependency on the lab. The
 * pair is held to the lab's own by `test/dedupe-receipt.test.ts`, which drives both over the
 * same spellings, so a currency added to the ledger fails there.
 */
const WIRE_AMOUNT = /^(?:CREDIT|USD):(-?)(0|[1-9][0-9]*)\.([0-9]{2})$/;

/** The signed 64-bit minor-unit range the ledger's amount columns hold. */
const MINOR_MIN = -(2n ** 63n);
const MINOR_MAX = 2n ** 63n - 1n;

/** A chain head as the ledger spells one: 32 bytes, lowercase hex. */
const CHAIN_HASH = /^[0-9a-f]{64}$/;

/** A key id: 16 lowercase hex characters, the width the ledger stamps on checkpoints. */
const KEY_ID = /^[0-9a-f]{16}$/;

/** The largest epoch-millisecond value a `Date` can hold, so rendering a receipt is total. */
const MAX_TIME = 8.64e15;

/**
 * A configured receipt codec.
 *
 * Binds the secrets, the lifetime, and the payload codec once, then offers operations over
 * them: sign a payload into a string a client can hold, verify one a client hands back, check
 * it against the posting the ledger holds, and render it for a human.
 *
 * There are two strengths of verification, and the difference is the point of this package.
 * `verify` proves the issuer issued it — that is all a signed blob can ever prove. Because the
 * payload carries the posting's chain link, `verifyAgainst` proves the stronger thing: that the
 * ledger holds the transaction the receipt names, with the history the receipt claims.
 */
export class Receipts {
  #decode: Decoder;
  #encode: Encoder;
  #keyring: Promise<Keyring>;
  #secrets: string[];
  #ttlMs: number | undefined;

  /**
   * @param options The secrets, lifetime, and payload codec to bind
   */
  constructor(options: ReceiptsOptions) {
    const {
      decode = defaultDecode,
      encode = defaultEncode,
      secrets,
      ttlMs,
    } = options;

    if (!Array.isArray(secrets) || secrets.length === 0) {
      throw new TypeError(
        'Receipts requires at least one secret. A receipt is always signed.',
      );
    }
    this.#secrets = [...secrets];
    // A blank or non-string secret reaches Web Crypto as a zero-length or stringified key, and
    // verify's single failure value would report the result as "every receipt is forged".
    if (!this.#secrets.every(isText)) {
      throw new TypeError(
        'Every Receipts secret must be a non-empty string. An empty secret cannot sign.',
      );
    }
    // Every comparison against NaN is false, so an unchecked lifetime would mean "never expires".
    if (
      ttlMs !== undefined &&
      !(typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs >= 0)
    ) {
      throw new TypeError(
        'Receipts ttlMs must be a non-negative, finite count of milliseconds.',
      );
    }

    this.#decode = decode;
    this.#encode = encode;
    this.#ttlMs = ttlMs;
    this.#keyring = Promise.all(
      this.#secrets.map(async (secret) => ({
        kid: await keyId(secret),
        secret,
      })),
    );
  }

  /**
   * Renders a payload as plain text for a person: a support desk reading back what a player
   * bought, who was paid, and where the posting sits in the chain.
   *
   * Formatting only. It reports what the payload says without checking any of it, so render
   * the result of `verify`, never a payload straight off the wire.
   *
   * @param payload The receipt to render
   * @returns Plain multi-line text, no trailing newline
   */
  describe(payload: Receipt): string {
    const lines = [`Receipt ${payload.txnId}`, row('User', payload.userId)];
    if (payload.kind !== undefined) lines.push(row('Operation', payload.kind));
    lines.push(row('Amount', payload.amount));
    lines.push(row('Issued', instant(payload.issuedAt)));
    if (this.#ttlMs !== undefined) {
      lines.push(row('Expires', instant(payload.issuedAt + this.#ttlMs)));
    }
    lines.push(row('Account', payload.link.account));
    lines.push(
      row('Chain', `${payload.link.prevHash} -> ${payload.link.hash}`),
    );

    const legs = payload.legs ?? [];
    if (legs.length > 0) {
      const width = Math.max(...legs.map((leg) => leg.account.length));
      lines.push('  Legs (debit-positive, as posted)');
      for (const leg of legs) {
        lines.push(`    ${leg.account.padEnd(width)}  ${leg.amount}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Reads the key id a receipt names, without verifying anything.
   *
   * Unauthenticated on its own: it says which key the string claims to be signed under, which
   * is what makes rotation observable in the field — a log of key ids shows how much traffic
   * still rides the retired secret. The claim only becomes a fact once `verify` returns a
   * payload, because the signature covers the key id along with the rest.
   *
   * @param value The receipt string
   * @returns The 16-hex key id, or `null` if the string is not shaped like a receipt
   */
  kidOf(value: string): string | null {
    return typeof value === 'string'
      ? (parseReceipt(value)?.kid ?? null)
      : null;
  }

  /**
   * How many secrets this codec will verify against. A rotation raises this by one and dropping
   * the retired secret lowers it again; the secrets themselves stay private to the codec.
   */
  get secretCount(): number {
    return this.#secrets.length;
  }

  /**
   * Signs a payload into one URL-safe string of the form `rcpt1.<kid>.<payload>.<signature>`.
   *
   * The payload is encoded first and the signature covers the scheme tag, the key id, and those
   * encoded bytes together, so writing the same receipt any other way produces a string this
   * codec will not accept.
   *
   * @param payload The committed transaction to issue a receipt for
   * @returns The receipt string to hand to the client
   */
  async sign(payload: Receipt): Promise<string> {
    const [key] = await this.#keyring;
    return signValue(
      `${SCHEME}.${key.kid}.${this.#encode(payload)}`,
      key.secret,
    );
  }

  /**
   * The lifetime of a receipt in milliseconds, or `undefined` when receipts never expire.
   */
  get ttlMs(): number | undefined {
    return this.#ttlMs;
  }

  /**
   * Reads a receipt string back into its payload, proving the issuer issued it.
   *
   * Returns `null` for every way this can fail: a key id naming no secret this codec holds, a
   * signature that does not check out, a payload edited in transit, a different format, a
   * payload that is not receipt-shaped, a malformed chain link, or a receipt older than
   * `ttlMs`. There is no throwing path and no failure detail — a forged receipt is a value to
   * branch on, and naming the failed check only helps the forger past it.
   *
   * This proves the issuer issued it and nothing more. A receipt naming a transaction that
   * never committed passes here; {@link Receipts.verifyAgainst} is what catches that.
   *
   * @param value The receipt string the client handed back
   * @returns The payload, or `null` if it cannot be trusted
   */
  async verify(value: string): Promise<Receipt | null> {
    if (typeof value !== 'string' || value === '') return null;
    try {
      return await this.#read(value);
    } catch {
      // verify has one failure value and it is null. Signing may fail loudly; verifying an
      // untrusted string may not, so even an unavailable Web Crypto lands here.
      return null;
    }
  }

  /**
   * Reads a receipt back and checks it against the posting the ledger actually holds.
   *
   * Everything `verify` checks, and then: the transaction carries the id the receipt names, it
   * touched the account the receipt's link names, and that account's chain advanced through
   * exactly the two hashes the receipt claims. That settles that the posting the receipt names
   * committed, with the history the receipt claims for it.
   *
   * It does not re-derive the legs. The ledger's hash covers them, but re-deriving it would take
   * the posting's own legs and metadata, which a {@link LedgerTransaction} does not carry — so
   * {@link Receipt.legs} rests on the signature, at the same strength as the rest of the payload.
   *
   * Fetching the transaction is the caller's half, over whatever read surface is at hand:
   * `read.transaction(id)`, or the lab's `findByHash` when the chain hash is all you have. This
   * package never reaches for a database.
   *
   * @param value The receipt string the client handed back
   * @param transaction The committed posting the ledger holds for `value`
   * @returns The payload, or `null` if it cannot be trusted or does not match
   */
  async verifyAgainst(
    value: string,
    transaction: LedgerTransaction,
  ): Promise<Receipt | null> {
    const payload = await this.verify(value);
    if (payload === null) return null;
    try {
      return matches(payload, transaction) ? payload : null;
    } catch {
      // verifyAgainst has the same single failure value verify does. A transaction that faults
      // while it is being read is one that does not match.
      return null;
    }
  }

  async #read(value: string): Promise<Receipt | null> {
    const parsed = parseReceipt(value);
    if (parsed === null) return null;

    const key = (await this.#keyring).find((k) => k.kid === parsed.kid);
    if (key === undefined) return null;

    // The signature covers `rcpt1.<kid>.<payload>`, so a matching one authenticates the span
    // parsed.encoded was taken from along with the key id that selected the secret.
    if ((await unsignValue(value, key.secret)) === false) return null;

    const payload = readPayload(parsed.encoded, this.#decode);
    if (payload === null) return null;
    if (
      this.#ttlMs !== undefined &&
      Date.now() - payload.issuedAt > this.#ttlMs
    ) {
      return null;
    }
    return payload;
  }
}

/**
 * Creates a new receipt codec.
 *
 * @param options The secrets, lifetime, and payload codec to bind
 * @returns A new {@link Receipts} object
 */
export function createReceipts(options: ReceiptsOptions): Receipts {
  return new Receipts(options);
}

/** Splits a receipt string positionally, before any secret is chosen. */
function parseReceipt(value: string): { kid: string; encoded: string } | null {
  if (!value.startsWith(`${SCHEME}.`)) return null;

  const rest = value.slice(SCHEME.length + 1);
  const kidEnd = rest.indexOf('.');
  if (kidEnd === -1) return null;

  const kid = rest.slice(0, kidEnd);
  if (!KEY_ID.test(kid)) return null;

  const signatureAt = rest.lastIndexOf('.');
  if (signatureAt <= kidEnd) return null;

  return { kid, encoded: rest.slice(kidEnd + 1, signatureAt) };
}

/** True when `transaction` is the posting `payload` names, with the chain step it claims. */
function matches(payload: Receipt, transaction: LedgerTransaction): boolean {
  if (!isRecord(transaction)) return false;
  if (transaction.id !== payload.txnId) return false;
  if (!Array.isArray(transaction.links)) return false;

  const posted = transaction.links.find(
    (link) => isRecord(link) && link.account === payload.link.account,
  );
  return (
    posted !== undefined &&
    lower(posted.prevHash) === payload.link.prevHash &&
    lower(posted.hash) === payload.link.hash
  );
}

function readPayload(encoded: string, decode: Decoder): Receipt | null {
  try {
    const payload = decode(encoded);
    return isReceipt(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Guards the decoded payload against anything that is not a receipt. A valid signature only
 * proves the bytes came from a holder of a secret; it does not prove they describe a
 * transaction, so the shape is checked before the payload is handed back.
 */
function isReceipt(value: unknown): value is Receipt {
  if (!isRecord(value)) return false;
  const { txnId, userId, amount, issuedAt, link, legs, kind } = value;
  return (
    isText(txnId) &&
    isText(userId) &&
    isWireAmount(amount) &&
    typeof issuedAt === 'number' &&
    Number.isSafeInteger(issuedAt) &&
    Math.abs(issuedAt) <= MAX_TIME &&
    isLink(link) &&
    (legs === undefined || isLegs(legs)) &&
    (kind === undefined || typeof kind === 'string')
  );
}

/**
 * A link is only usable as evidence if it is spelled the way the ledger spells one. A hash of
 * the wrong width or case could never match a stored head, so a receipt carrying one is
 * rejected here rather than failing mysteriously against the ledger later.
 */
function isLink(value: unknown): value is ReceiptLink {
  if (!isRecord(value)) return false;
  return (
    isText(value.account) &&
    typeof value.prevHash === 'string' &&
    CHAIN_HASH.test(value.prevHash) &&
    typeof value.hash === 'string' &&
    CHAIN_HASH.test(value.hash)
  );
}

function isLegs(value: unknown): value is ReceiptLeg[] {
  return (
    Array.isArray(value) &&
    value.every(
      (leg) => isRecord(leg) && isText(leg.account) && isWireAmount(leg.amount),
    )
  );
}

/**
 * An amount is evidence only if it is one the ledger could have posted. A grammar wider than the
 * ledger's is how a receipt comes to carry a currency no economy mints or a magnitude no column
 * holds, signed and therefore believed.
 */
function isWireAmount(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = WIRE_AMOUNT.exec(value);
  if (match === null) return false;

  const [, sign, whole, fraction] = match;
  const magnitude = BigInt(whole + fraction);
  // Zero has one spelling and it is the unsigned one, so `-0.00` is a second name for a value.
  if (sign === '-') return magnitude !== 0n && -magnitude >= MINOR_MIN;
  return magnitude <= MINOR_MAX;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function lower(value: unknown): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(9)} ${value}`;
}

/** Renders an epoch millisecond, clamped to the range a `Date` holds so describe never throws. */
function instant(ms: number): string {
  return new Date(Math.min(Math.max(ms, -MAX_TIME), MAX_TIME)).toISOString();
}

function defaultDecode(encoded: string): Receipt {
  return JSON.parse(decodeTextBase64Url(encoded)) as Receipt;
}

function defaultEncode(payload: Receipt): string {
  return encodeTextBase64Url(JSON.stringify(payload));
}
