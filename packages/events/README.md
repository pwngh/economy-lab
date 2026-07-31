# events

The event vocabulary for [`@pwngh/economy`](../economy). `events` names the fourteen types the
economy emits, the shape they all share, and the guards that turn one off a queue into a value
a `switch` can read.

## Features

- **A fourteen-type roster:** `EVENT_TYPES` frozen, in the lab's own order, checked against the
  lab on every test run — a name absent here is a name nothing sends.
- **One envelope:** every event carries `id`, `type`, `version`, `occurredAt`, `subject`,
  `data`, and `audience`, whatever it is about.
- **Data per type:** [`narrowEvent`](#narrowing-one-event) hands a `switch` the right `data`
  in each branch, so a settled payout's `netUsd` and a sale's `giftTo` are typed, not cast.
- **Types only, no client:** nothing here connects, subscribes, or stores. It describes what
  arrives; [delivering it](#the-delivery-contract) is the outbox relay's job.
- **Zero dependencies of its own:** the lab is the only one, and the roster is its roster.

## Installation

```sh
npm i @pwngh/economy
```

## Usage

```ts
import { narrowEvent } from '@pwngh/economy/events';

let event = narrowEvent(JSON.parse(body));
if (event === null) return; // not a rostered event; nothing to handle

switch (event.type) {
  case 'economy.sale.completed':
    event.data.txnId; // 'txn_0f8c3a41'
    event.data.giftTo; // 'usr_ben' when the buyer bought for someone else
    break;
  case 'economy.payout.settled':
    event.data.netUsd; // 'USD:95.00'
    break;
  default:
    break; // a new type is a no-op, not a crash
}
```

### Narrowing one event

```ts
import { isEvent, isEventType } from '@pwngh/economy/events';

isEventType('economy.subscription.lapsed'); // true
isEvent(event, 'economy.payout.settled'); // narrows event.data to the settled shape
```

`narrowEvent` checks the envelope and the roster. It does not inspect `data` — those shapes
come from the emitters, on the emitters' word. A handler acting on a field from a sender it
does not trust checks that field itself.

### The delivery contract

Delivery is at-least-once, through the outbox relay. The relay writes each event in the same
database transaction as the money that caused it, then delivers it separately, and retries
until it succeeds or dead-letters.

What follows from that:

- **Dedupe by `event.id`.** The same event will arrive twice. The id is stable across
  redeliveries; nothing else is.
- **No ordering between events.** A renewal can land before the start it follows. Read
  `occurredAt` when order matters, and never infer it from arrival.
- **Never load-bearing for money.** The money is already committed and already correct when
  the event is written. A handler that never runs costs a notification, not a balance.

### Audience

```ts
event.audience; // 'client' | 'internal'
```

A `client` event is one the host pushes to connected clients. An `internal` event —
`economy.credits.clawed_back`, `economy.payout.settled`, `economy.payout.reversed`,
`economy.fees.swept`, `economy.instance.settled` — is for your own systems, and forwarding one
to a user tells them things the operator knows.

## Related Packages

- [`@pwngh/economy`](../economy) — the module that emits these
- [`@pwngh/economy-webhook`](../webhook) — the inbound direction: a provider's callback in
- [`@pwngh/economy-client`](../client) — the reads that show the state an event announced

## License

[MIT](../../LICENSE.md)
