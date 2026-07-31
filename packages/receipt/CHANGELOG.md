# Changelog

Notable changes to `@pwngh/economy-receipt`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `createReceipts` and the `Receipts` class: a codec that signs a committed transaction into a string and reads it back.
- `receipts.sign(payload)` writes `rcpt1.<kid>.<payload>.<signature>`, base64url throughout and safe in a URL without escaping.
- Every segment is canonical base64url, so one receipt has exactly one string that verifies.
- `Receipt.amount` and each `legs[].amount` verify only in the ledger's canonical wire form: `CREDIT` or `USD`, exactly two decimal places, no leading zero, and inside the 64-bit minor-unit range the ledger stores.
- `receipts.verify(value)` returns the payload or `null`. Every way a receipt can fail is that one answer, and there is no throwing path.
- `receipts.verifyAgainst(value, transaction)` adds the ledger check: the transaction carries the id the receipt names and advanced the chain through the two hashes it claims. The caller fetches the transaction; this package opens no connection.
- `receipts.kidOf` reads the key id without verifying, and `receipts.describe` renders a payload as plain text for a support desk.
- `secrets` is read newest-first, so a rotation is a prepend; `ttlMs` expires a receipt from its `issuedAt`, checked after the signature.
- An empty `secrets` array, an entry that is not a non-empty string, and a non-finite `ttlMs` each throw a `TypeError` at construction.
- Web Crypto is the only runtime dependency; the package has none of its own.
