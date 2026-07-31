/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { decodeAmountWire, ERROR_CODES } from '@pwngh/economy-lab';
import type { Economy, Operation, Principal } from '@pwngh/economy-lab';
import { FIELDS, OPERATION_FIELDS } from '@pwngh/economy-lab/contract';
import {
  correlationOf,
  encodeOutcome,
  faultResponse,
  isCallerToken,
  problemResponse,
  REQUEST_ID_HEADER,
} from '@pwngh/economy-lab/server';
import type { Authenticate, FetchHandler } from '@pwngh/economy-lab/server';
import { OWN_SUBJECT } from './module.js';
import type { ResolvedModule, RouteHandler } from './module.js';

// Route drafts are in-process values, so amounts arrive typed (credits(), usd()). A wire
// string like 'CREDIT:120.00' would pass the door and fault in the store as a 503; the
// boundary refuses it by name instead. Returns the offending field path, or null.
function wireAmountAt(value: unknown, path: string): string | null {
  if (typeof value === 'string') {
    if (!value.includes(':')) return null;
    try {
      decodeAmountWire(value);
    } catch {
      return null;
    }
    return path;
  }
  if (typeof value !== 'object' || value === null) return null;
  for (const [k, v] of Object.entries(value)) {
    const at = Array.isArray(value)
      ? `${path}[${k}]`
      : path === ''
        ? k
        : `${path}.${k}`;
    const hit = wireAmountAt(v, at);
    if (hit !== null) return hit;
  }
  return null;
}

// The fields the lab sets and no caller may send: on the operation, absent from the wire table.
// Derived from the two published tables rather than listed, so a second server-set field joins
// this the day the lab declares one. Returns the offending field name, or null.
//
// A route handler is reached by an HTTP request and may spread its body wholesale, so a draft is a
// caller's body until something says otherwise. The rail's own report — the one writer of
// `providerReported` — builds its Operation in the webhook mapper and never passes here.
function serverSetFieldIn(draft: Record<string, unknown>): string | null {
  const complete = OPERATION_FIELDS[draft.kind as Operation['kind']] as
    | Record<string, unknown>
    | undefined;
  if (complete === undefined) return null;
  const wire = FIELDS[draft.kind as Operation['kind']] as Record<
    string,
    unknown
  >;
  for (const field of Object.keys(complete)) {
    if (!(field in wire) && draft[field] !== undefined) return field;
  }
  return null;
}

export function composeRoutes(
  mod: ResolvedModule,
  wires: { economy: Economy; authenticate: Authenticate | false },
  labHandler: FetchHandler,
): FetchHandler {
  const table = new Map(Object.entries(mod.routes ?? {}));
  // complexity 22: one request path, branching per route shape and per handler answer.
  // eslint-disable-next-line complexity
  return async (request) => {
    const route = table.get(
      `${request.method} ${new URL(request.url).pathname}`,
    );
    if (!route) return labHandler(request);

    const correlationId = correlationOf(request);
    const withId = (res: Response) => {
      res.headers.set(REQUEST_ID_HEADER, correlationId);
      return res;
    };
    let principal: Principal | null = null;
    if (wires.authenticate !== false) {
      try {
        principal = await wires.authenticate(request);
      } catch (error) {
        return withId(faultResponse(error));
      }
      if (principal === null) {
        return withId(
          problemResponse(401, 'Request is not authenticated.', {
            code: ERROR_CODES.UNAUTHORIZED,
            retryable: false,
          }),
        );
      }
    }

    let result: Awaited<ReturnType<RouteHandler>>;
    try {
      result = await route({ request, principal });
    } catch (error) {
      return withId(faultResponse(error));
    }
    // The handler answered for itself; the framework adds nothing.
    if (result instanceof Response) return result;

    // The key originates with the caller, always — a retried request must reuse it.
    const key =
      request.headers.get('idempotency-key') ??
      request.headers.get(REQUEST_ID_HEADER);
    if (key === null || !isCallerToken(key)) {
      return withId(
        problemResponse(
          400,
          "An Operation route needs the caller's key — send an idempotency-key " +
            '(or x-request-id) header.',
        ),
      );
    }
    // Same actor law as the lab door: an authenticated principal is stamped and the handler
    // may not set its own; `authenticate: false` trusts the handler's actor and requires it.
    if (principal !== null && result.actor !== undefined) {
      return withId(
        problemResponse(
          400,
          `routes["${request.method} ${new URL(request.url).pathname}"] returned an Operation ` +
            'carrying its own actor — the authenticated principal is the actor.',
        ),
      );
    }
    if (principal === null && result.actor == null) {
      return withId(
        problemResponse(
          400,
          '`authenticate: false` trusts the handler to set the actor — this route returned an ' +
            'Operation without one.',
        ),
      );
    }
    const serverSet = serverSetFieldIn(result as Record<string, unknown>);
    if (serverSet !== null) {
      return withId(
        problemResponse(
          400,
          `routes["${request.method} ${new URL(request.url).pathname}"] returned a draft naming ` +
            `\`${serverSet}\` — the server sets that field, and the lab's own door refuses a ` +
            'request body carrying it.',
          { code: ERROR_CODES.MALFORMED_OPERATION, retryable: false },
        ),
      );
    }
    const wirePath = wireAmountAt(result, '');
    if (wirePath !== null) {
      return withId(
        problemResponse(
          400,
          `routes["${request.method} ${new URL(request.url).pathname}"] returned a draft with a ` +
            `wire-string amount at \`${wirePath}\` — amounts are typed in-process: use credits(), ` +
            'usd(), or toAmount().',
          { code: ERROR_CODES.MALFORMED_OPERATION, retryable: false },
        ),
      );
    }
    // The persona grammar: a user principal fills its own subject when the draft omits it.
    const field = OWN_SUBJECT[result.kind];
    const own =
      field &&
      (result as Record<string, unknown>)[field] === undefined &&
      principal?.kind === 'user'
        ? { [field]: principal.userId }
        : {};
    const operation = {
      ...result,
      idempotencyKey: key,
      ...(principal === null ? {} : { actor: principal }),
      ...own,
    } as Operation;
    try {
      const outcome = await wires.economy.submit(operation, { correlationId });
      return withId(
        new Response(JSON.stringify(encodeOutcome(outcome)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    } catch (error) {
      return withId(faultResponse(error));
    }
  };
}
