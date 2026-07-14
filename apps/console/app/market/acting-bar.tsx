/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The acting-as bar: who the market forms submit as. Natural acts as each form's own owner (the
 * gates apply); a seed identity acts as that user; Platform / Operator act with privilege.
 */

import { Form } from 'react-router';

import { BackField, entityName } from '~/ui';

// The acting-as options. The empty value is "natural" — each form acts as its own buyer or seller,
// so the gates apply. A seed identity acts as that user (act on a wallet it doesn't own to provoke
// the authorization gate); Platform / Operator act with privilege, bypassing the pause and
// authorization gates.
function actorOptions(users: string[]): { value: string; label: string }[] {
  return [
    { value: '', label: 'Natural — the buyer or seller' },
    { value: 'system', label: 'Platform (privileged)' },
    { value: 'operator', label: 'Operator (privileged)' },
    ...users.map((id) => ({ value: id, label: entityName(id) })),
  ];
}

export function ActingBar({
  users,
  actor,
  back,
  busy,
}: {
  users: string[];
  actor: string | null;
  back: string;
  busy: boolean;
}) {
  return (
    <Form method="post" action="/actions/actor" className="acting-bar">
      <BackField to={back} />
      <label htmlFor="acting-actor">Acting as</label>
      <select id="acting-actor" name="actor" defaultValue={actor ?? ''}>
        {actorOptions(users).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button type="submit" disabled={busy}>
        Switch
      </button>
      <span className="acting-note">
        By default each purchase and payout submits as its own owner, so the
        gates apply. Switch to another identity to act on a wallet you
        don&apos;t own (the authorization gate refuses it), or to Platform /
        Operator to act with privilege — bypassing the maintenance and
        authorization gates the way a real operator does.
      </span>
    </Form>
  );
}
