/**
 * @pwngh/economy-auth
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { CLIENT_IP_HEADER } from '@pwngh/economy-lab/server';
import { systemActor, userActor } from './identity.js';
import type { Authenticate, Principal } from './identity.js';
import { bearerOf } from './bearer.js';

export interface DevToken {
  readonly label: string;
  readonly token: string;
  readonly principal: Principal;
}

/** Deterministic bearer tokens; only devAuthenticate's table (the dev posture, loopbackOnly) accepts them. */
function devTokenList(): readonly DevToken[] {
  return [
    { label: 'ada', token: 'dev_user_ada', principal: userActor('usr_ada') },
    { label: 'ben', token: 'dev_user_ben', principal: userActor('usr_ben') },
    {
      label: 'payments',
      token: 'dev_system_payments',
      principal: systemActor('payments'),
    },
  ];
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** A runtime with no `process` states no environment, so it is never treated as one that
 *  is safe to answer dev tokens on. Reading it directly would throw at request time. */
const outsideProduction = (): boolean =>
  typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

/**
 * The dev-token table, gated: answers only on loopback requests (the client-address header
 * the Node bridge stamps) outside production, and stays inert otherwise — safe as a
 * `bearerStack` tail. The hardened `serve` refusals still apply to bare `devTokens`.
 */
function loopbackOnly(): Authenticate {
  const table = devAuthenticate(devTokenList());
  return async (request) => {
    if (!outsideProduction()) return null;
    const ip = request.headers.get(CLIENT_IP_HEADER);
    return ip !== null && LOOPBACK.includes(ip) ? table(request) : null;
  };
}

export const devTokens: (() => readonly DevToken[]) & {
  loopbackOnly(): Authenticate;
} = Object.assign(devTokenList, { loopbackOnly });

export function devAuthenticate(tokens: readonly DevToken[]) {
  const byToken = new Map(tokens.map((t) => [t.token, t.principal]));
  return async (request: Request): Promise<Principal | null> => {
    const bearer = bearerOf(request);
    return (bearer && byToken.get(bearer)) || null;
  };
}
