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
 * The store implementer's toolkit. The conformance suite (the `/testing` entry point) is the
 * public invitation to bring your own {@link ports!Store Store}. These are the primitives a
 * conforming implementation needs to compute the same chain hashes, balance deltas, orderings,
 * and wire encodings the built-in engines compute — without reaching into unsupported
 * internals.
 *
 * @module store-kit
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the Store
 *   port and the conformance suite that holds every implementation to identical behavior.
 */

/**
 * The account's next chain head, as 64 lowercase hex characters.
 *
 * The head is the digest (SHA-256 in every shipped runtime) over a fixed byte layout of four
 * length-prefixed frames, each frame preceded by its 4-byte big-endian length. The frames, in
 * order: the previous head's raw bytes ({@link GENESIS} for an account's first posting), the
 * UTF-8 transaction id, this account's own legs, and the posting meta serialized as JSON with
 * object keys sorted at every depth. Legs naming other accounts are excluded.
 *
 * The leg frame encodes each leg as a `CURRENCY:decimal` wire string (debit-positive,
 * credit-negative, fixed two decimals), sorted as strings and joined by a NUL byte. Amounts
 * inside meta must already be wire strings. A raw bigint throws rather than guess a format.
 *
 * The layout is fixed so the same posting reproduces the same bytes, and hash, on later
 * verification. A store that persists heads computed this way re-derives byte-identically
 * under offline verification.
 *
 * @example
 * const amount = toAmount('CREDIT', 120_000n); // a $10 top-up at 120 CREDIT per dollar
 * const head = await chainHash(systemDigest, {
 *   accountPrevHash: GENESIS,
 *   txnId: 'txn_01',
 *   account: spendable('usr_9'),
 *   legs: [credit(spendable('usr_9'), amount), debit(SYSTEM.STORED_VALUE, amount)],
 *   meta: { source: 'card' },
 * });
 */
export { chainHash } from '#src/ledger.ts';

/**
 * The signed amount a leg moves its account's balance by. Leg amounts are stored debit-positive
 * and credit-negative everywhere. This flips the sign for credit-normal accounts (user wallets,
 * liability accounts such as revenue and the payout reserve) and passes debit-normal ones
 * through.
 * A store folding running balances sums this, never the raw leg amount: the credit leg funding a
 * user's spendable account is stored negative but must raise the balance.
 */
export { balanceDelta } from '#src/ledger.ts';

/**
 * The 32-byte zero hash an account's chain starts from: the previous-head input of the first
 * posting that touches an account. Stores keeping heads as bytes compare against this. Stores
 * keeping heads as text compare against {@link GENESIS_HEX}.
 */
export { GENESIS } from '#src/ledger.ts';

/**
 * {@link GENESIS} as lowercase hex — 64 zero characters, the one spelling every stored text head
 * compares against.
 */
export { GENESIS_HEX } from '#src/ledger.ts';

/**
 * Strips a platform shard suffix: `platform:revenue#3` becomes `platform:revenue`. Ids without a
 * `platform:` prefix or a `#` pass through unchanged. Identity checks normalize through this —
 * a shard row behaves exactly like its base account.
 */
export { baseOf } from '#src/accounts.ts';

/**
 * The id of a platform account's shard `k`: the bare id for 0, `base#k` otherwise. Shard 0
 * keeps the bare id: a deployment with one shard writes exactly the unsharded rows.
 */
export { shardRef } from '#src/accounts.ts';

/**
 * All shard ids of a base account, bare id first — `max(1, shards)` entries, so a shard count of 0
 * behaves like 1. A reader sums the balances of every id returned here to get the logical balance
 * of a sharded platform account.
 */
export { shardsOf } from '#src/accounts.ts';

/**
 * The wallet kind encoded after the last `:` in a user account id (`usr_9:spendable` gives
 * `'spendable'`), or null when the suffix is absent or unknown — platform accounts return null.
 * This is the one parser for the id shape, shared with the built-in stores' known-account
 * checks. A custom store that recognizes accounts through it accepts exactly the same ids.
 */
export { walletKindOf } from '#src/accounts.ts';

/**
 * Whether an account grows on a debit (true) rather than a credit (false). It decides a leg's
 * sign against its account's normal side, so a store folding balances or checking for an
 * overdraft reads every balance right-way-up. The companion to {@link balanceDelta}, which
 * applies the same rule to one leg's amount.
 */
export { isDebitNormal } from '#src/accounts.ts';

/**
 * Orders two strings by raw UTF-16 code units, returning -1, 0, or 1. Code-unit order is
 * identical on every runtime and machine, unlike a locale-aware comparison. It is the one
 * ordering the engines sort listings by — the conformance suite checks account listings against
 * it — so results and any hash derived from sorted ids match across backends. A custom store
 * sorts with this comparator wherever the Store port promises ordered results.
 */
export { byCodeUnit } from '#src/bytes.ts';

/**
 * Decodes lowercase hex into bytes, for stores that keep hashes as text. Throws a
 * MALFORMED_OPERATION coded fault on an odd length or any character outside `0-9a-f` (uppercase
 * digits are rejected). A malformed head never decodes into the wrong bytes.
 */
export { fromHex } from '#src/bytes.ts';

/**
 * Encodes bytes as lowercase hex, the inverse of {@link fromHex}. Hand-rolled so it exists on
 * every target runtime (no `Buffer`). The result feeds cross-runtime hashes, so lowercase is
 * the only spelling it ever produces.
 */
export { toHex } from '#src/bytes.ts';

/**
 * Encodes bytes as unpadded base64url, for a value that travels in a URL or a JWS segment.
 */
export { toBase64Url } from '#src/bytes.ts';

/**
 * Decodes base64url into bytes, the inverse of {@link toBase64Url}. Accepts only the canonical
 * spelling: `atob` alone would also take padding, the standard alphabet, embedded whitespace and
 * unused trailing bits, which gives one signature many spellings that all verify. Throws a
 * MALFORMED_OPERATION coded fault on anything else.
 */
export { fromBase64Url } from '#src/bytes.ts';

/**
 * Reads one field out of a posting's free-form meta, returning it only when it is a string and the
 * caller's `fallback` otherwise. Kept free of SQL and store specifics so a non-SQL store never
 * imports engine code for a plain JSON lookup.
 */
export { metaString, holdReleaseLotFields } from '#src/meta.ts';

/**
 * Reads one field out of a posting's free-form meta, returning it only when it is a number and the
 * caller's `fallback` otherwise.
 */
export { metaNumber } from '#src/meta.ts';

/**
 * Deep-walks any JSON-shaped value and swaps every branded Amount for its `CURRENCY:decimal`
 * wire string (fixed two decimals, `CREDIT:12.34`) and every bare bigint for its decimal
 * string. Everything else is left untouched, so the result survives `JSON.stringify`. A custom
 * store encodes an event body with it to stay byte-compatible. An Operation has its own writer,
 * {@link encodeOperation}, which every shipped transport goes through.
 */
export { encodeAmounts } from '#src/money.ts';

/**
 * The inverse walk: every string that parses in full as `CURRENCY:decimal` becomes an Amount
 * again. Any other string — an idempotency key, a sku — passes through unchanged. Amounts
 * round-trip exactly through {@link encodeAmounts} and back. Bare bigints do not. They come
 * back as their decimal strings.
 *
 * The walk reads values, not keys, so a string field holding text spelled like an amount comes
 * back branded. Decode a stored Operation with {@link decodeStoredOperation} instead, which
 * knows which fields the kind declares as amounts.
 */
export { decodeAmounts } from '#src/money.ts';

/**
 * Spells an Operation for a store's inbox column. Both SQL engines and the HTTP store adapter
 * write the column through this one function, so every backend holds the same bytes; a store
 * persisting operations encodes with it rather than walking them itself.
 */
export { encodeOperation } from '#src/wire-contract.ts';

/** What {@link encodeOperation} produces: an Operation as a JSON column holds it. */
export type { EncodedOperation } from '#src/wire-contract.ts';

/**
 * Reads an Operation back out of a store's inbox column, decoding only the fields its kind
 * declares as amounts. This is the read half of what {@link encodeOperation} wrote there; a store
 * persisting operations decodes with it so a sku, a source or a provider reference spelled like
 * an amount comes back as the text the caller sent.
 */
export { decodeStoredOperation } from '#src/wire-contract.ts';

/**
 * The currency the trust store's velocity window counts in: `CREDIT`. The per-class limit and
 * every running total are held in CREDIT minor units, so the risk check compares them directly.
 * A custom store's velocity read returns its `spent` total in this currency.
 */
export { VELOCITY_CURRENCY } from '#src/trust.ts';

/**
 * The wallet kinds {@link walletKindOf} can return: `spendable`, `earned`, `promo`, `escrow`, and `reserved`.
 * A category, not a currency — the currency of any money movement comes from the amount itself.
 */
export type { AccountKind } from '#src/accounts.ts';

/**
 * Every optional surface the conformance suite branches on. An implementation reads it to see
 * exactly which surfaces are optional, and what a skip in the suite's output is naming.
 */
export { STORE_CAPABILITIES } from '#src/store-capabilities.ts';

/**
 * What a store offers, derived by looking at it. Pass the `unit` from an open transaction —
 * ledger capabilities resolve there, because that is the only level at which locking means
 * anything and the two levels genuinely disagree on some engines.
 */
export { capabilitiesOf } from '#src/store-capabilities.ts';

/**
 * Where a store's declared capabilities disagree with what it carries. The conformance suite
 * refuses a store on any conflict, so an implementation can run this itself and get the same
 * answer before the suite does.
 */
export { capabilityConflicts } from '#src/store-capabilities.ts';

/** One optional surface's name. The roster is {@link STORE_CAPABILITIES}. */
export type { StoreCapability } from '#src/ports.ts';

/**
 * Folds a user's live entitlement rows into the one row per sku
 * {@link ports!EntitlementStore.list EntitlementStore.list} streams. Ownership is per
 * `(userId, sku, source)`, so a sku bought twice holds two rows, and the collapse decides the sku's
 * expiry (a perpetual source wins, otherwise the longest) and its `sources` list. Both orderings
 * are computed here rather than in SQL, so an engine's collation never changes the answer.
 */
export { collapseEntitlementGrants } from '#src/entitlements.ts';

/** One stored entitlement row as {@link collapseEntitlementGrants} reads it. */
export type { EntitlementRowRef } from '#src/entitlements.ts';
