# auth

The `authenticate` posture for [`@pwngh/economy`](https://www.npmjs.com/package/@pwngh/economy).
`auth` verifies bearer JWTs against a JWKS endpoint, matches static API keys, answers
loopback dev tokens, composes those resolvers into one, and builds the three actors — user,
system, operator — the ledger authorizes against.

Your login flow owns identity: sessions, passwords, OAuth, your user database.
`@pwngh/economy-auth` owns turning the credential that flow issued into a `Principal` the
ledger will accept. That is why there are no OAuth providers here — you already have a login
system, and the economy only needs to know who is calling.

## Features

- **One seam, four resolvers.** `authenticate` is a single function,
  `(request) => Promise<Principal | null>`. [JWKS](#jwks-bearer-tokens),
  [API keys](#static-api-keys), and [dev tokens](#dev-tokens) all fit it, and
  [`bearerStack`](#composing-resolvers) chains them.
- **Strict bearer grammar.** Every resolver requires the `Bearer ` prefix. A raw token
  without it answers `null`, never throws, and never half-parses.
- **JWKS without a dependency.** `fetch` plus WebCrypto: `RS256`, `ES256`, `EdDSA`, one
  shared fetch per cache window, and [rotation handling](#jwks-bearer-tokens) that never
  herds a struggling identity provider.
- **Null is the only refusal.** A malformed, expired, unsigned, or unknown credential
  resolves `null` — a 401 at the door. Nothing here throws at request time; a
  misconfiguration throws at construction instead, where it was written.
- **Actors, not strings.** [`userActor`, `systemActor`, `operatorActor`](#actors-and-authorization)
  are what a resolver returns and what the ledger checks, so authorization is a value, not
  a convention.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

```ts
// economy.app.ts
import { authJwks } from '@pwngh/economy/auth';

export const authenticate = authJwks(
  'https://id.example.com/.well-known/jwks.json',
);
```

That is the whole posture. A request arrives, the resolver answers a `Principal` or `null`,
and the framework stamps what it answered onto the operation.

```ts
let resolve = authJwks('https://id.example.com/.well-known/jwks.json');

await resolve(request); // userActor('usr_ada')
await resolve(anonymousRequest); // null
```

### The bearer grammar

Every resolver here reads the same header the same way: `Authorization: Bearer <credential>`.
The `Bearer ` prefix is required. The scheme name is case-insensitive and the separating
whitespace may be wide, but the prefix itself is never optional.

```ts
import { authApiKeys, systemActor } from '@pwngh/economy/auth';

let resolve = authApiKeys({ sk_live_1: systemActor('payments') });
let sent = (authorization: string) =>
  new Request('https://shop.example/v1/wallet', {
    headers: { authorization },
  });

await resolve(sent('Bearer sk_live_1')); // systemActor('payments')
await resolve(sent('bearer sk_live_1')); // systemActor('payments') — the scheme is case-insensitive
await resolve(sent('sk_live_1')); // null — a raw credential is not a bearer token
await resolve(sent('Bearersk_live_1')); // null — the scheme needs its space
await resolve(sent('Basic sk_live_1')); // null
await resolve(sent('Bearer ')); // null — an empty credential
```

A credential the resolver cannot accept answers `null`. Nothing here throws at request
time: a missing header, a malformed token, a bad signature, and an expired token are all
the same answer, and the framework turns it into one 401.

### Composing resolvers

`bearerStack` tries each resolver in order and takes the first principal. A `null` falls
through to the next, so the production resolver goes first and the dev tail goes last.

```ts
import { bearerStack, authJwks, devTokens } from '@pwngh/economy/auth';

export const authenticate = bearerStack(
  authJwks('https://id.example.com/.well-known/jwks.json'),
  devTokens.loopbackOnly(),
);
```

An element that is not a function refuses at construction, not on the first request:

```ts
bearerStack(devTokens.loopbackOnly(), 'jwks'); // TypeError: bearerStack: element 2 is not an Authenticate function
```

### JWKS bearer tokens

`authJwks` verifies `Authorization: Bearer <jwt>` against the keys published at a JWKS URL.
It signs nothing and stores nothing; `fetch` and WebCrypto do all the work.

```ts
import { authJwks, systemActor } from '@pwngh/economy/auth';

let resolve = authJwks('https://id.example.com/.well-known/jwks.json', {
  issuer: 'https://id.example.com/', // checked against `iss` when set
  audience: 'economy', // checked against `aud`, string or array
  cacheMs: 300_000, // key cache lifetime; 0 refetches every verification
  clockToleranceMs: 0, // exp and nbf are exact by default
  principal: (
    claims, // default maps `sub` to a user actor
  ) => (claims.svc === 'payments' ? systemActor('payments') : null),
});
```

Algorithms are pinned to `RS256`, `ES256`, and `EdDSA`, and the chosen key must agree with
the token's own algorithm — no signing with an encryption key, no algorithm swap. An unknown
`kid` is what rotation looks like, so it triggers one extra refresh, floored at once per
thirty seconds. Concurrent verifications during a cold start share a single fetch.

A bad answer never takes verification down: a transport error, a non-JSON body, an HTTP
error, or a key set larger than 100 keys all leave the cached keys serving. A well-formed
answer carrying no keys is the exception — an identity provider that publishes an empty set
has revoked everything, and that does take effect. Anything the resolver cannot verify — a
wrong signature, a past `exp`, a future `nbf`, a foreign `iss` — answers `null`.

A token is exactly three segments, each canonical base64url. A fourth segment, the standard
base64 alphabet, `=` padding, embedded whitespace, and a final character carrying unused
bits are all refused, so one credential has exactly one accepted spelling. `nbf` is checked
whenever it is present: a `nbf` that is not a number is malformed, not absent.

The options are read once, at construction. A window that is not a finite, non-negative
count of milliseconds would never satisfy a comparison — `now - NaN` is `NaN`, and every
comparison against `NaN` is false — so it is refused rather than silently disabling the gate
it measures. A blank `issuer` or `audience` is a missing value, not a disabled check; omit
the option to check nothing.

```ts
authJwks(url, { clockToleranceMs: NaN }); // TypeError: authJwks: clockToleranceMs must be a finite count of milliseconds, not NaN
authJwks(url, { cacheMs: -1 }); // TypeError: authJwks: cacheMs must be a finite count of milliseconds, not -1
authJwks(url, { issuer: '' }); // TypeError: authJwks: issuer is blank — omit it to check nothing
authJwks(url, { issuer: undefined }); // fine — the issuer is deliberately unchecked
```

### Static API keys

`authApiKeys` is the table for machine callers: your payment processor's webhook relay, an
internal service, a back-office job. You build the map from your own secret store.

```ts
import { authApiKeys, systemActor, operatorActor } from '@pwngh/economy/auth';

let resolve = authApiKeys({
  [process.env.PAYMENTS_KEY!]: systemActor('payments'),
  [process.env.BACKOFFICE_KEY!]: operatorActor('ops_ada'),
});

await resolve(request); // systemActor('payments')
```

Lookup runs on SHA-256 digests of the key material, so comparison time never walks the
secret. A key that is not in the map answers `null` — the table never reports which part
of a guess was close.

An unset environment variable does not fail on its own — it stringifies, and the table would
mint a live credential spelled `undefined`. The four spellings a missing or non-string value
produces are refused as keys instead.

```ts
let missing = process.env.NOT_SET; // undefined

authApiKeys({ [missing!]: systemActor('payments') }); // TypeError: authApiKeys: "undefined" is a missing secret, not a key
authApiKeys({ '': systemActor('payments') }); // TypeError: authApiKeys: "" is a missing secret, not a key
authApiKeys({}); // fine — a table that never answers is a real posture
```

### Dev tokens

`devTokens()` is a fixed list of three principals with deterministic bearer values, so a
dev shell and its tests agree on who is who.

```ts
import { devTokens } from '@pwngh/economy/auth';

devTokens(); // [{ label: 'ada', token: 'dev_user_ada', principal: userActor('usr_ada') }, …]
```

`devTokens.loopbackOnly()` is the gated resolver you actually mount. It answers only when
the request carries the loopback client address the dev server's Node bridge stamps, and it
is inert whenever `NODE_ENV` is `production` — safe as a `bearerStack` tail on a server that
binds a port.

```ts
let resolve = devTokens.loopbackOnly();

await resolve(loopbackRequest); // userActor('usr_ada')
await resolve(remoteRequest); // null — a public address is never loopback
await resolve(noAddressRequest); // null — an unstamped request is not loopback either
```

A runtime with no `process` — a Worker without the Node compatibility shim — states no
environment at all. It is treated as one the table must not answer on, rather than read
through and throw:

```ts
await resolve(loopbackRequest); // null — no stated environment is never "not production"
```

`devAuthenticate(tokens)` is the raw table with no gate at all, for an in-process test that
never binds anything. It takes any token list, including your own.

### Actors and authorization

A resolver's whole job is to produce one of three actors, and which one it produces decides
what the request may do.

```ts
import { userActor, systemActor, operatorActor } from '@pwngh/economy/auth';

userActor('usr_ada'); // an end user, acting for itself
systemActor('payments'); // a service, acting for the platform
operatorActor('ops_ada'); // a human operator, acting on the platform
```

The law the ledger enforces:

- A user principal may move only its own money. A user may not debit another account, and
  a user token reads only itself.
- Acting for another user takes a system or operator actor. Minting, clawbacks, and
  settlements are barred to a user outright.
- A request body that carries its own `actor` is refused, not overridden. The server stamps
  the principal `authenticate` resolved, so a caller can never name itself.

That last rule is why these constructors ship beside the resolvers rather than with the
operation constructors in `@pwngh/economy-core/ops`: on a network request the only legitimate
source of an actor is the posture that authenticated it.

## Related Packages

- [`@pwngh/economy-core`](https://www.npmjs.com/package/@pwngh/economy-core) — `createApp` and the module contract, whose `authenticate` seam this package fills.
- [`@pwngh/economy-cli`](https://www.npmjs.com/package/@pwngh/economy-cli) — the `economy` command: `dev`, `serve`, `worker`, `check`, `routes`.
- [`@pwngh/economy-test`](https://www.npmjs.com/package/@pwngh/economy-test) — the deterministic harness, with personas that stand in for the principals resolved here.
- [`@pwngh/economy-adapters`](https://www.npmjs.com/package/@pwngh/economy-adapters) — framework mounts for Express and Fastify.
- [`@pwngh/economy-lab`](https://www.npmjs.com/package/@pwngh/economy-lab) — the floor: the ledger, the ports, and the `Principal` type re-exported here.

## License

MIT
