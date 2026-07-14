/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The acting-as selection as an engine principal, shared by the market's spend and payout actions.
 * An unknown value defaults to the platform system actor, the console's own operator view.
 */

import type { Principal } from '#src/index.ts';

export function principal(actor: string): Principal {
  if (actor === 'operator') {
    return { kind: 'operator', operatorId: 'ops_console' };
  }
  if (/^usr_[a-z0-9_]+$/.test(actor)) {
    return { kind: 'user', userId: actor };
  }
  return { kind: 'system', service: 'console' };
}
