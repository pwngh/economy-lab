/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * Shared form primitives for the market sections (app/market/*): the owned-flash lookup and its
 * live region, an inline field note, and the seed-identity select.
 */

import type { Flash } from '~/flash';
import { FlashBanner, entityName } from '~/ui';

// The field-level error a given form's `invalid` flash carries for one input, or null.
export function fieldError(
  flash: Flash | null,
  form: string,
  name: string,
): string | null {
  if (flash && flash.kind === 'invalid' && flash.form === form) {
    return flash.fields[name] ?? null;
  }
  return null;
}

// The flash the given form owns, in its own aria-live region beside the form. The region is always
// mounted so a screen reader announces the message that arrives into it after a submit.
export function OwnedFlash({
  flash,
  form,
}: {
  flash: Flash | null;
  form: string;
}) {
  const owned = flash && flash.form === form ? flash : null;
  return (
    <div aria-live="polite" className="owned-flash">
      {owned ? <FlashBanner flash={owned} /> : null}
    </div>
  );
}

export function FieldNote({ id, error }: { id: string; error: string | null }) {
  return error ? (
    <div id={id} className="field-error">
      {error}
    </div>
  ) : null;
}

// A select of the seed identities. `fallback` is the default when it is one of the users; when
// `allowNone` is set the first option is an empty "no one" for optional recipients.
export function UserSelect({
  id,
  name,
  users,
  fallback,
  allowNone,
}: {
  id: string;
  name: string;
  users: string[];
  fallback: string;
  allowNone?: boolean;
}) {
  const known = users.includes(fallback);
  return (
    <select id={id} name={name} defaultValue={known ? fallback : ''}>
      {allowNone ? <option value="">No one (self-purchase)</option> : null}
      {!known && !allowNone ? (
        <option value={fallback}>{fallback}</option>
      ) : null}
      {users.map((u) => (
        <option key={u} value={u}>
          {entityName(u)}
        </option>
      ))}
    </select>
  );
}
