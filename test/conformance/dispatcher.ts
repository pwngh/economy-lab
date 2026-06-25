/// <reference types="node" />
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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeEvent } from '#src/adapters/event-wire.ts';

import type { Dispatcher, EconomyEvent } from '#src/ports.ts';

/**
 * Wraps one Dispatcher adapter over a controllable fake transport: it records the message bodies
 * sent and the abort signals seen, and `failNext` makes the next dispatch fail (a thrown transport
 * error), so the shared suite can exercise the success, failure, and cancellation paths uniformly.
 */
export interface DispatcherHarness {
  dispatcher: Dispatcher;
  bodies: ReadonlyArray<string>;
  signals: ReadonlyArray<AbortSignal | undefined>;
  failNext(error: Error): void;
}

function sampleEvent(): EconomyEvent {
  return {
    id: 'evt_conf_1',
    type: 'economy.sale.completed',
    version: 1,
    occurredAt: 0,
    subject: 'usr_conf_1',
    // Money travels as a string so the JSON body never serializes a bigint.
    data: { orderId: 'ord_1', amount: '5.00' },
    audience: 'internal',
  };
}

/**
 * The shared {@link Dispatcher} contract every adapter must satisfy, run against the HTTP and SQS
 * adapters over fake transports — the same pattern as `test/conformance/store.ts`.
 *
 * The encoding test pins both transports to one byte-for-byte body (`encodeEvent`), so HTTP and SQS
 * can't silently diverge in what a receiver sees; the failure test pins the error contract the relay
 * worker depends on (retryable `PROVIDER.FAILURE` so a delivery redelivers); the signal test pins
 * cancellation forwarding.
 */
export function runDispatcherConformance(
  name: string,
  makeHarness: () => DispatcherHarness,
): void {
  describe(`Dispatcher Conformance: ${name}`, () => {
    test('sends the event as the one canonical encoded body', async () => {
      let h = makeHarness();
      await h.dispatcher(sampleEvent());
      assert.equal(h.bodies.length, 1);
      assert.equal(h.bodies[0], encodeEvent(sampleEvent()));
    });

    test('a transport failure throws a retryable PROVIDER.FAILURE', async () => {
      let h = makeHarness();
      h.failNext(new Error('transport down'));
      await assert.rejects(h.dispatcher(sampleEvent()), (error: unknown) => {
        let fault = error as { code?: string; retryable?: boolean };
        assert.equal(fault.code, 'PROVIDER.FAILURE');
        assert.equal(fault.retryable, true);
        return true;
      });
    });

    test('forwards the caller abort signal to the transport', async () => {
      let h = makeHarness();
      let signal = new AbortController().signal;
      await h.dispatcher(sampleEvent(), { signal });
      assert.equal(h.signals.at(-1), signal);
    });
  });
}
