# sqs

The Amazon SQS dispatcher for [`@pwngh/economy`](../economy). One call takes a queue URL and
hands back the `Dispatcher` the outbox relay delivers through, with the AWS client, the command
translation, and the error mapping already inside it.

## Features

- **One factory:** `sqs({ queueUrl })` opens the client and returns the dispatcher. No
  `SQSClient`, no `SendMessageCommand`, no command objects at the call site.
- **FIFO detected from the URL:** a `.fifo` suffix switches on dedup by event id and grouping by
  subject. A standard queue omits both, because AWS rejects them there.
- **One canonical body:** the same `encodeEvent` every transport in the economy uses, so a
  consumer reading from SQS parses exactly what an HTTP consumer parses.
- **Failures come back retryable:** a rejected send throws `PROVIDER.FAILURE` with `retryable`
  set, so the relay's backoff takes it rather than dead-lettering on the first blip.

## Installation

```sh
npm i @pwngh/economy
```

`@aws-sdk/client-sqs` comes with it.

## Usage

```ts
import { sqs } from '@pwngh/economy/sqs';

export let ports = {
  dispatcher: await sqs({ queueUrl: process.env.SQS_QUEUE_URL! }),
};
```

Credentials and region come from the SDK's own resolution chain — environment, shared config, or
the instance role. Pass `region` to pin it.

### FIFO and ordering

```ts
let dispatch = await sqs({
  queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/economy.fifo',
});

await dispatch(event); // dedup by event.id, group by event.subject
```

On a FIFO queue, one subject's events deliver in order and a resend inside the dedup window is
dropped at the queue. On a standard queue, neither holds and the receiver dedupes by the
`id` in the body.

### Bringing your own client

```ts
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqsDispatcher } from '@pwngh/economy/sqs';

let raw = new SQSClient({ region: 'us-east-1' });
let dispatch = sqsDispatcher({
  queueUrl: process.env.SQS_QUEUE_URL!,
  client: {
    send: async (command, options) =>
      raw.send(new SendMessageCommand(command.input), options) as Promise<
        Record<string, unknown>
      >,
  },
});
```

The adapter speaks an SDK-free `{ input }` command, which is what lets a test drive it with a
plain object. Handing it a real client is the same call with the translation written out.

Ownership follows creation, and the types carry it. A dispatcher built over your client has no
`close`, so nothing here destroys a client you opened. `sqs({ queueUrl })` is the other way round:
it opened the client, so it hands back a `close()` and the economy calls it.

### What this package does not do

- **It does not receive.** This is the outbound half. Consuming the queue is your service's job,
  and it must dedupe by `event.id` because delivery is at-least-once.
- **It does not create the queue.** The queue, its policy, and its dead-letter target are
  infrastructure, not something a running app should provision.
- **It does not batch.** One event, one `SendMessage`. The relay controls the rate.
- **It carries no money.** An event announces a posting that already committed. A dispatch that
  never lands costs a notification, not a balance.

## Related Packages

- [`@pwngh/economy`](../economy) — the economy whose outbox feeds this
- [`@pwngh/economy-events`](../events) — the typed vocabulary of what arrives
- [`@pwngh/economy-redis`](../redis) — the cache and rate limiter, which are different ports

## License

[MIT](../../LICENSE.md)
