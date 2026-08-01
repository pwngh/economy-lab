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
 * This repository's own economy, as an `EconomyModule`. `economy dev`, `economy serve` and
 * `economy worker` find this directory with no flag and boot it the way they boot a scaffolded
 * project — same bin, same contract, same refusals. The Docker image runs `economy serve` over
 * this file.
 *
 * The environment still decides the store, the cache, the rates and the payout provider;
 * `openPorts` reads it. What is stated here is only what the environment cannot say: the auth
 * posture, the provider callback this deployment accepts, and whichever optional integrations
 * {@link openHostWirings} found opted in.
 */

import { openHostWirings } from '#economy/lib/host.ts';
import { decodeWebhookEvent } from '#src/webhooks.ts';
import { jsonlLogger } from '#src/runtime.ts';

import type { EconomyModule } from '@pwngh/economy/module';

const host = await openHostWirings(process.env, jsonlLogger());

/** The optional integrations this environment opted into; undefined when it opted into none. */
export const ports = host.ports;

export const flags = host.flags;

/**
 * The purchase callback: money in, reported by the payment processor. The framework verifies the
 * signature and the timestamp before this decoder ever runs, and the decoded event lands in the
 * inbox for the next sweep rather than posting on the request path.
 */
export const providers = {
  billing: (raw: unknown) => decodeWebhookEvent('billing', raw),
};

/**
 * This host trusts the actor named in the body, which is what the lab's own suites, demos and
 * rigs drive it as. A deployment that faces the public internet exports a resolver here instead.
 */
export const authenticate = false;

({ ports, flags, providers, authenticate }) satisfies EconomyModule;
