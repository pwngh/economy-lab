# receipt

A receipt is a signed, self-contained record of one committed transaction that a client holds
and hands back. It carries the posting's place in the ledger's hash chain, so it proves not just
that you issued it but that the ledger says it happened.

## Features

- **Chain-bound, not merely signed:** the payload carries the posting's chain link — the account's
  head hash before and after. A signature proves the issuer issued it; the link is what lets
  anyone later check the receipt against the ledger's own history.
- **Two strengths of verification:** `verify` checks the signature and the shape offline.
  `verifyAgainst` additionally matches the receipt's chain link to the posting the ledger holds,
  which is the only thing that catches a signed receipt for a transaction that never committed.
- **Secret rotation with key ids:** every receipt is stamped with the id of the key that signed
  it, so verification selects the right secret directly and a log of key ids shows how much
  traffic still rides the retired one.
- **Bounded lifetime:** an optional `ttlMs` expires a receipt, measured from the `issuedAt` the
  issuer signed rather than one the holder supplied.
- **Readable by a person:** `describe` renders a receipt as plain text — the legs, who paid what
  to whom, fee lines included — for the support desk case where a player says they bought
  something and did not get it.
- **No exceptions on the verify path:** verification returns the payload or `null`, never a
  throw, so a forged receipt is a value you branch on rather than an error you catch.
- **Runs anywhere:** Web Crypto and nothing else. No dependencies and no Node-only APIs, so the
  same code verifies in a worker, at the edge, or in the process that issued it.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

```ts
import { createReceipts } from '@pwngh/economy/receipt';

let receipts = createReceipts({
  secrets: [process.env.SIGNING_SECRET],
  ttlMs: 1000 * 60 * 60 * 24 * 30, // thirty days
});

receipts.secretCount; // 1
receipts.ttlMs; // 2592000000

// A transaction just committed. Issue a receipt from what it returned.
let value = await receipts.sign({
  txnId: transaction.id,
  userId: 'usr_4c1d9e',
  amount: 'CREDIT:600.00', // a $5.00 top-up at 120 credits to the dollar
  issuedAt: transaction.postedAt,
  link: transaction.links.find((l) => l.account === 'usr_4c1d9e:spendable'),
  legs: [
    { account: 'usr_4c1d9e:spendable', amount: 'CREDIT:-600.00' },
    { account: 'system:issuance', amount: 'CREDIT:600.00' },
  ],
  kind: 'topUp',
});

value; // "rcpt1.02f7835f83428482.eyJ0eG5JZCI6InR4bl8wZjhjM2E0MS02ZDUyLTRiOTAtOWMxNy0yZTVhOGI0ZDdmMDMiLCJ1c2VySWQiOiJ1c3JfNGMxZDllIiwiYW1vdW50IjoiQ1JFRElUOjYwMC4wMCIsImlzc3VlZEF0IjoxNzUzNTc0NDAwMDAwLCJsaW5rIjp7ImFjY291bnQiOiJ1c3JfNGMxZDllOnNwZW5kYWJsZSIsInByZXZIYXNoIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsImhhc2giOiJjODFkNGUyYjlmMGEzNzU2MWU4ZDRjMmE5MGJmNzNlNWQxNmE4YzRmMmIwOWU3ZDM1YTFjNmY4YjQyMGQ5ZTczIn0sImxlZ3MiOlt7ImFjY291bnQiOiJ1c3JfNGMxZDllOnNwZW5kYWJsZSIsImFtb3VudCI6IkNSRURJVDotNjAwLjAwIn0seyJhY2NvdW50Ijoic3lzdGVtOmlzc3VhbmNlIiwiYW1vdW50IjoiQ1JFRElUOjYwMC4wMCJ9XSwia2luZCI6InRvcFVwIn0.nxh01d4JQlwbUAuN2zdzW6nOCOui85wEOLV57sOQ2bw"

// Later, from whatever the client hands back
let receipt = await receipts.verify(value);

receipt.txnId; // "txn_0f8c3a41-6d52-4b90-9c17-2e5a8b4d7f03"
receipt.amount; // "CREDIT:600.00"
receipt.link.hash; // "c81d4e2b9f0a37561e8d4c2a90bf73e5d16a8c4f2b09e7d35a1c6f8b420d9e73"
```

The payload is the shape the ledger commits: `txnId` is the posting's id, `issuedAt` is when it
posted, `link` is its entry in `transaction.links`, and `amount` is the canonical wire form —
`CREDIT` or `USD`, a colon, and exactly two decimal places, ungrouped. An amount in any other
currency, spelled any other way, or past the 64-bit minor-unit range the ledger stores is one no
posting could carry, so a receipt holding it does not verify.

`verify` returns `null` for every way this can fail: a key id naming no secret it holds, a bad
signature, a payload edited in transit, a receipt past its `ttlMs`, a malformed chain link, a
payload that is not receipt-shaped, or a string that was never a receipt. It never throws, and it
never reports which check failed — so a forged receipt is a value you branch on, not an exception
you catch, and the branch tells the holder nothing they can use.

```ts
let receipt = await receipts.verify(untrusted);

if (receipt === null) {
  return new Response('Not a valid receipt', { status: 400 }); // the only failure there is
}
```

### Secret rotation

`secrets` is an array so that changing one never invalidates the receipts already issued under
it. Start with a single secret:

```ts
let receipts = createReceipts({ secrets: ['secret1'] });

receipts.secretCount; // 1

let value = await receipts.sign(purchase);

receipts.kidOf(value); // "5b11618c2e440278", the id of the key that signed it
```

Every receipt issued here is signed with `secret1` and stamped with its id. Later, when it's time
to rotate, add the new secret to the **beginning** of the array rather than replacing what's
there:

```ts
let receipts = createReceipts({ secrets: ['secret2', 'secret1'] });

receipts.secretCount; // 2

// Receipts signed with either secret verify, selected by the id they carry
let receipt = await receipts.verify(value); // the payload, signed under secret1

receipts.kidOf(value); // "5b11618c2e440278", still naming the old key

// Newly signed receipts use secret2, the first entry
let reissued = await receipts.sign(purchase);

receipts.kidOf(reissued); // "35224d0d3465d74e"
```

Drop `secret1` from the end once every receipt signed under it has passed its `ttlMs` — and the
key ids are how you know when that is, because logging `kidOf` on the receipts coming in tells
you how much live traffic still rides the retired key. Until then, a verifier holding only the
new secret rejects everything issued before the rotation:

```ts
let tooEager = createReceipts({ secrets: ['secret2'] });

await tooEager.verify(value); // null
await tooEager.verify(reissued); // the payload
```

A key id is the first 16 lowercase hex characters of the secret's SHA-256 — the same width and
spelling the ledger stamps on sealed checkpoints, where it is the first 16 hex of the signing
key. It names the key without carrying anything that could sign with it, and the signature covers
it, so restamping a receipt with a different id breaks it rather than redirecting it.

This is the array the economy already keeps. `SIGNING_SECRET` is the head and the comma-separated
`SIGNING_SECRETS_PRIOR` is the tail, so a deployment already configured for checkpoint rotation is
already configured for this:

```ts
let prior = (process.env.SIGNING_SECRETS_PRIOR ?? '')
  .split(',')
  .filter(Boolean);

let receipts = createReceipts({
  secrets: [process.env.SIGNING_SECRET, ...prior],
});

receipts.secretCount; // 2, after one rotation
```

There is no unsigned mode. A codec built with an empty `secrets` array throws a `TypeError` at
construction, because an unsigned receipt is not tamper-evident and nothing else here would mean
anything. So does one built with a blank or non-string secret — an unset `SIGNING_SECRET` would
otherwise reach Web Crypto as a zero-length key, and since `verify` has only one failure value
the result would read as "every receipt is forged" rather than "the deployment is misconfigured".

### Checking a receipt against the ledger

A signature proves one thing: whoever holds the secret issued this string. It cannot tell you the
transaction ever happened — a leaked or misused secret can sign a receipt for a purchase that
never posted, and `verify` will accept it, because as far as the signature is concerned it is
genuine.

The chain link is the answer. Every posting the ledger commits advances a hash chain per account
it touched, so the link in the payload names a step in a history the issuer does not control.
When the ledger is reachable, `verifyAgainst` checks it:

```ts
let transaction = await read.transaction(receipt.txnId);

let verified = await receipts.verifyAgainst(value, transaction);

verified; // the payload, or null
```

It returns `null` unless everything `verify` requires holds _and_ the transaction carries the id
the receipt names, touched the account the receipt's link names, and advanced that account's chain
through exactly the two hashes the receipt claims.

It **does not re-derive the legs**. The ledger's hash is taken over the transaction id, the
account, every leg, and the metadata together, so a real posting's link does commit to its legs —
but re-deriving that hash needs the posting's own legs and metadata, and a `LedgerTransaction`
carries neither. So `legs` in the payload rests on the signature, at the same strength as
`amount` and `kind`. A holder cannot touch it; whoever holds the secret can write it freely and
still match a real link. If you need the legs checked, compare them against the transaction
yourself once `verifyAgainst` has returned.

```ts
// A receipt signed correctly for a transaction that never committed
await receipts.verify(invented); // the payload — the signature is genuine
await receipts.verifyAgainst(invented, posted); // null — the ledger disagrees
```

Fetching the transaction is the caller's half. Pass whatever your read surface returns:
`read.transaction(id)` when you have the id, or the lab's `findByHash` when a chain hash is all
you have. This package never opens a connection, which is what keeps it usable at the edge.

### Bounded lifetime

`ttlMs` expires a receipt, counted from the `issuedAt` in its payload:

```ts
let receipts = createReceipts({
  secrets: [process.env.SIGNING_SECRET],
  ttlMs: 1000 * 60 * 15, // fifteen minutes
});

let fresh = await receipts.sign({ ...purchase, issuedAt: Date.now() });
let stale = await receipts.sign({
  ...purchase,
  issuedAt: Date.now() - 1000 * 60 * 20,
});

await receipts.verify(fresh); // the payload
await receipts.verify(stale); // null
```

A receipt is good through exactly `ttlMs` and null one millisecond after it.

The window is checked only after the signature is, so the `issuedAt` it reads is one the issuer
signed. A holder cannot extend their own receipt by editing the timestamp: that edit breaks the
signature first, and the expiry check never runs. Omit `ttlMs` for receipts that should outlive
any window — a purchase confirmation a player can still produce a year later.

Omitting it is the only way to say that. A `ttlMs` that is not a non-negative finite number
throws a `TypeError` at construction, because `Number(process.env.RECEIPT_TTL)` on an unset
variable is `NaN`, every comparison against `NaN` is false, and the codec would have expired
nothing while reporting a lifetime. An issuer's clock is trusted here: an `issuedAt` in the
future outlives its window by however far ahead it was stamped.

### Reading a receipt as a person

The support case is a player saying they bought something and did not get it. `describe` renders a
verified payload as plain text, for a human rather than a machine:

```ts
let receipt = await receipts.verify(value);

console.log(receipts.describe(receipt));
```

```
Receipt txn_0f8c3a41-6d52-4b90-9c17-2e5a8b4d7f03
  User      usr_4c1d9e
  Operation topUp
  Amount    CREDIT:600.00
  Issued    2025-07-27T00:00:00.000Z
  Expires   2025-08-26T00:00:00.000Z
  Account   usr_4c1d9e:spendable
  Chain     0000000000000000000000000000000000000000000000000000000000000000 -> c81d4e2b9f0a37561e8d4c2a90bf73e5d16a8c4f2b09e7d35a1c6f8b420d9e73
  Legs (debit-positive, as posted)
    usr_4c1d9e:spendable  CREDIT:-600.00
    system:issuance       CREDIT:600.00
```

A `prevHash` of 64 zeros is genesis: this was the account's first posting. Leg amounts are
debit-positive, which is the ledger's sign and not the account holder's — a top-up's wallet leg
reads negative even though the player gained credits. Turning a leg into the change in that
account's balance means knowing which accounts are debit-normal, which is the lab's
`balanceDelta` from `@pwngh/economy-lab/store-kit`.

`describe` is formatting and nothing else. It reports what the payload says without checking any
of it, so render the result of `verify`, never a payload straight off the wire.

### What the signature covers

A receipt is four parts: `rcpt1.<kid>.<payload>.<signature>`. The payload is encoded first and the
signature is taken over `rcpt1.<kid>.<payload>` exactly as written — the encoded bytes, not the
values they stand for.

```ts
let value = await receipts.sign(purchase);

value.split('.').length; // 4
value.startsWith('rcpt1.'); // true
encodeURIComponent(value) === value; // true, so it drops into a URL or a QR code untouched
```

Three consequences worth knowing. Writing the same receipt any other way — a different key order,
different whitespace, a different codec — produces bytes the signature does not cover, so it fails
verification even though nothing about the transaction changed. The `rcpt1` scheme tag sits inside
the signed bytes, so a correctly signed value from some other format is `null` here rather than
something to be talked into. And the key id is signed too, so it can be read before verification
to pick a secret without being a place to attack.

### Custom encoding

By default the payload is JSON wrapped in base64url, which keeps the whole receipt safe to drop
into a URL or a path segment as-is. Supply your own pair to change that:

```ts
let receipts = createReceipts({
  secrets: [process.env.SIGNING_SECRET],
  encode: (r) =>
    [
      r.txnId,
      r.userId,
      r.amount,
      r.issuedAt,
      r.link.account,
      r.link.prevHash,
      r.link.hash,
    ].join('~'),
  decode: (text) => {
    let [txnId, userId, amount, issuedAt, account, prevHash, hash] =
      text.split('~');
    return {
      txnId,
      userId,
      amount,
      issuedAt: Number(issuedAt),
      link: { account, prevHash, hash },
    };
  },
});

let value = await receipts.sign(purchase);

value; // "rcpt1.02f7835f83428482.txn_0f8c3a41-6d52-4b90-9c17-2e5a8b4d7f03~usr_4c1d9e~CREDIT:600.00~1753574400000~usr_4c1d9e:spendable~0000000000000000000000000000000000000000000000000000000000000000~c81d4e2b9f0a37561e8d4c2a90bf73e5d16a8c4f2b09e7d35a1c6f8b420d9e73.ZR5CaNfjiePrKlwYV1Y8qyDSk4O-lvOJhS5TAMX0syk"
```

A custom `encode` is the whole payload codec: its return value is signed and placed in the receipt
as-is, with no base64url wrapper around it. That buys a receipt you can read at a glance in a log,
and it costs you the guarantee the default gives — the example above carries a `:` in the amount,
so this one needs escaping before it goes in a URL. Return only characters that are safe wherever
your receipts travel.

A `decode` that throws needs no handling of its own; it is a verification failure like any other
and `verify` returns `null`. Whatever the codec, the decoded payload is still checked against the
receipt shape before it is handed back — including that the chain hashes are 64 lowercase hex
characters, because a hash the ledger could never have written should fail here rather than
mysteriously later.

### What this package is not

This package owns **one transaction's** tamper-evident record: signing it, verifying it, matching
its chain link against a posting you hand in, and rendering it for a person. That is the whole
scope.

It does not own ledger-wide proof. Merkle roots over account heads, sealing and verifying
checkpoints, re-deriving every chain from genesis, `verifyExport`, and solvency all live in the
lab — `@pwngh/economy-lab`, in `src/chain.ts`, `src/integrity.ts`, and `src/verify-export.ts`.
If that family is ever extracted it will be its own package, not this one.

It also does not read your database. `verifyAgainst` compares a receipt to a transaction you have
already fetched; finding that transaction, including the bounded hash lookup `findByHash`
performs, is the lab's job and the caller's call. Naming the line here is deliberate: a receipt
package that quietly grew a ledger connection would stop running at the edge, which is most of
why this one is worth having.

## Related Packages

- [`@pwngh/economy`](https://www.npmjs.com/package/@pwngh/economy) - Wallets, payouts, subscriptions, and a marketplace on one double-entry ledger
- [`@pwngh/economy-cli`](https://www.npmjs.com/package/@pwngh/economy-cli) - The `economy` command: dev, serve, worker, check, routes
- [`@pwngh/economy-money`](https://www.npmjs.com/package/@pwngh/economy-money) - Where the `CREDIT:600.00` wire form is parsed and written

## License

See [LICENSE.md](https://github.com/pwngh/economy-lab/blob/main/LICENSE.md)
