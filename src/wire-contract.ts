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
 * The published wire contract: every operation's field table, the served route registry,
 * and the OpenAPI document generated from them plus the rejection catalog. The server
 * decodes with the same table, so the spec cannot drift from the implementation.
 *
 * @module contract
 */

import {
  ERROR_CODES,
  REJECTION_CODES,
  REJECTION_SPEC,
  fault,
} from '#src/errors.ts';
import { decodeCanonicalAmount, encodeAmounts, isAmount } from '#src/money.ts';
import { SAGA_STATES, SUBSCRIPTION_STATES } from '#src/ports.ts';
import type { Operation } from '#src/contract.ts';

/** The wire type of one operation field. A trailing `?` marks the field optional. */
export type BaseSpec =
  | 'string'
  | 'int'
  | 'boolean'
  | 'amount'
  | 'recipients'
  | 'object';
export type Spec = BaseSpec | `${BaseSpec}?`;

/**
 * Every field of every operation kind, with its shape — the server-set ones included, which is
 * what separates this from {@link FIELDS}. The mapped type is the gate's completeness proof: a new
 * kind in the union, or a new field on any variant, stops this file compiling until its shape is
 * declared. `kind`, `idempotencyKey`, and `actor` ride every variant and are checked by the server
 * before the rows apply.
 *
 * {@link assertOperationShape} and {@link decodeStoredOperation} read this one, so a field a
 * request body may not carry is still shape-checked wherever it is set.
 */
export const OPERATION_FIELDS: {
  readonly [K in Operation['kind']]: {
    readonly [F in Exclude<
      keyof Extract<Operation, { kind: K }>,
      'kind' | 'idempotencyKey' | 'actor'
    >]-?: Spec;
  };
} = {
  topUp: { userId: 'string', amount: 'amount', source: 'string' },
  spend: {
    orderId: 'string',
    buyerId: 'string',
    sku: 'string',
    price: 'amount',
    recipients: 'recipients',
    ageRestricted: 'boolean?',
    giftTo: 'string?',
  },
  refund: { orderId: 'string', reason: 'string?' },
  clawback: {
    userId: 'string',
    amount: 'amount',
    orderId: 'string?',
    key: 'string?',
    reason: 'string?',
  },
  requestPayout: { userId: 'string', amount: 'amount' },
  subscribe: {
    userId: 'string',
    sellerId: 'string',
    sku: 'string',
    price: 'amount',
    periodMs: 'int',
  },
  cancelSubscription: { subscriptionId: 'string' },
  grantEntitlement: { userId: 'string', sku: 'string', attrs: 'object?' },
  revokeEntitlement: { userId: 'string', sku: 'string', reason: 'string?' },
  grantPromo: { userId: 'string', amount: 'amount', expiresAt: 'int' },
  adjust: { account: 'string', amount: 'amount', reason: 'string' },
  reverse: { txnId: 'string', reason: 'string' },
  reversePayout: {
    userId: 'string',
    sagaId: 'string',
    reason: 'string',
    providerReported: 'boolean?',
  },
  settlePayout: {
    sagaId: 'string',
    providerRef: 'string',
    providerAmount: 'amount?',
  },
};

/**
 * The fields the server sets and no caller may send. `providerReported` waives `reversePayout`'s
 * settlement-window refusal on the payout rail's own report, so a caller able to send it could
 * reverse a payout the rail is still settling and be paid twice. `toReversePayout` is the only
 * writer.
 */
const SERVER_SET_FIELDS = {
  reversePayout: ['providerReported'],
} as const satisfies {
  readonly [K in Operation['kind']]?: ReadonlyArray<
    Exclude<
      keyof Extract<Operation, { kind: K }>,
      'kind' | 'idempotencyKey' | 'actor'
    >
  >;
};

type ServerSetField<K extends Operation['kind']> =
  K extends keyof typeof SERVER_SET_FIELDS
    ? (typeof SERVER_SET_FIELDS)[K][number]
    : never;

type WireFields = {
  readonly [K in Operation['kind']]: {
    readonly [F in Exclude<
      keyof Extract<Operation, { kind: K }>,
      'kind' | 'idempotencyKey' | 'actor' | ServerSetField<K>
    >]-?: Spec;
  };
};

/**
 * Every field a caller may send, with its wire shape: {@link OPERATION_FIELDS} minus every
 * {@link SERVER_SET_FIELDS} row. This is the decodable set. The HTTP door decodes against it and
 * refuses a body naming anything else, and the OpenAPI document publishes exactly these, so a
 * server-set field is not something a caller can discover, generate a client for, or send.
 */
export const FIELDS: WireFields = withoutServerSetFields();

// The one derivation, so the two tables cannot disagree about a field's shape. The cast is sound
// because the filter drops exactly the keys WireFields excludes.
function withoutServerSetFields(): WireFields {
  const table: Record<string, Record<string, Spec>> = {};
  for (const [kind, rows] of Object.entries(OPERATION_FIELDS)) {
    const serverSet = SERVER_SET_FIELDS[
      kind as keyof typeof SERVER_SET_FIELDS
    ] as readonly string[] | undefined;
    table[kind] = Object.fromEntries(
      Object.entries(rows as Record<string, Spec>).filter(
        ([field]) => serverSet?.includes(field) !== true,
      ),
    );
  }
  return table as WireFields;
}

// One predicate per declared shape, over a field that has already been decoded — the value as it
// sits on an Operation, not the JSON that carried it. `amount` is the one shape whose two sides
// differ: on the wire it is the string `CREDIT:12.34`, in an Operation it is a branded Amount, so
// the HTTP door checks the string and converts, and this table checks what the conversion produced.
const SHAPES: { readonly [T in BaseSpec]: (value: unknown) => boolean } = {
  string: (value) => typeof value === 'string' && value !== '',
  int: (value) => Number.isSafeInteger(value),
  boolean: (value) => typeof value === 'boolean',
  amount: isAmount,
  recipients: (value) => Array.isArray(value) && value.every(isRecipient),
  object: (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value),
};

function isRecipient(entry: unknown): boolean {
  const row = entry as { sellerId?: unknown; shareBps?: unknown } | null;
  return (
    row !== null &&
    typeof row === 'object' &&
    SHAPES.string(row.sellerId) &&
    SHAPES.int(row.shareBps)
  );
}

// What the refusal calls each shape, so a caller reads the fix off the message.
const SHAPE_NAMES: { readonly [T in BaseSpec]: string } = {
  string: 'a non-empty string',
  int: 'an integer',
  boolean: 'a boolean',
  amount: 'an Amount',
  recipients: 'an array of { sellerId: string, shareBps: integer }',
  object: 'an object',
};

/**
 * Whether a value has the shape `spec` declares. A trailing `?` admits `undefined`, so an absent
 * optional field passes and a present one is checked like a required one.
 *
 * @example
 * hasWireShape('string?', undefined); // true — the field is absent
 * hasWireShape('string', 12);         // false
 */
export function hasWireShape(spec: Spec, value: unknown): boolean {
  const optional = spec.endsWith('?');
  if (optional && value === undefined) {
    return true;
  }
  return SHAPES[(optional ? spec.slice(0, -1) : spec) as BaseSpec](value);
}

/**
 * Refuses an Operation carrying a field the contract does not type that way, naming the field.
 *
 * TypeScript stops this at compile time; nothing else did. A host calling from JavaScript, through
 * an `as` cast, or with data off an untyped source reaches the handlers with any value at all, and
 * an account id is built by interpolation — a non-string `userId` becomes the account
 * `[object Object]:spendable`, and the posting commits. This runs over {@link OPERATION_FIELDS}, so
 * a new kind or field is covered the moment it is declared, and a server-set field is covered on
 * the path that sets it.
 *
 * @example
 * assertOperationShape({ kind: 'topUp', userId: {}, ... });
 * // throws OP.MALFORMED: topUp.userId must be a non-empty string.
 */
export function assertOperationShape(operation: Operation): void {
  const kind = operation.kind;
  if (!(kind in OPERATION_FIELDS)) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `Unknown operation kind "${String(kind)}".`,
      { detail: { kind: String(kind) } },
    );
  }
  const row = operation as unknown as Record<string, unknown>;
  for (const [field, tag] of Object.entries(
    OPERATION_FIELDS[kind] as Record<string, Spec>,
  )) {
    if (!hasWireShape(tag, row[field])) {
      const base = (tag.endsWith('?') ? tag.slice(0, -1) : tag) as BaseSpec;
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        `${kind}.${field} must be ${SHAPE_NAMES[base]}.`,
        { detail: { kind, field } },
      );
    }
  }
}

/** An Operation as it is spelled inside a JSON column, or on the wire that carries one. */
export type EncodedOperation = Record<string, unknown>;

/**
 * Spells an Operation for storage, the write half of what {@link decodeStoredOperation} reads
 * back. Every transport that persists an Operation writes it through this: the two SQL engines
 * into their inbox JSON column, the HTTP store adapter onto its wire.
 *
 * The Amount-brand walk codes every variant with no per-kind branch, so a new arm of the union
 * needs no edit here — the write does not need the field table the read does, because a value
 * either is a branded Amount or is not. It also swaps a bare bigint for its decimal string, which
 * the read half does not reverse: an Operation carrying one would not round-trip.
 *
 * The cast is sound for every arm: an Operation is a plain object, so the walk takes its object
 * branch and returns one.
 *
 * @example
 * await db.query('insert into inbox (operation) values ($1)', [
 *   JSON.stringify(encodeOperation(message.operation)),
 * ]);
 */
export function encodeOperation(operation: Operation): EncodedOperation {
  return encodeAmounts(operation) as EncodedOperation;
}

/**
 * Reads an Operation back out of storage, decoding the fields {@link OPERATION_FIELDS} declares
 * `amount` and handing back every other field as the column holds it. It reads the complete table
 * rather than the wire one, because a stored row legitimately carries the server-set fields.
 *
 * The write half is the key-blind Amount-brand walk, and running that walk backwards is not its
 * inverse: it sees values, never keys, so it re-brands any string that parses as a wire amount.
 * A `sku` spelled `CREDIT:12.34` came back as an Amount on a field the contract types `string`,
 * and one spelled `CREDIT:60000` failed the read outright. The field table tells an amount from
 * text that resembles one.
 *
 * A declared amount must carry the spelling `encodeAmount` writes; anything else throws
 * INVALID_AMOUNT naming the field. A `kind` this build does not declare passes through
 * undecoded: refusing a stored row here fails every page read that carries it, and the kind is
 * refused where the operation is applied.
 *
 * @example
 * const operation = decodeStoredOperation(JSON.parse(row.operation));
 * // a topUp's `amount` is an Amount again; its `source` is still the string the caller sent
 */
export function decodeStoredOperation(stored: unknown): Operation {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'A stored operation must be a JSON object.',
      { detail: { stored: Array.isArray(stored) ? 'array' : typeof stored } },
    );
  }
  const row: Record<string, unknown> = {
    ...(stored as Record<string, unknown>),
  };
  const kind = row.kind;
  if (typeof kind !== 'string' || !(kind in OPERATION_FIELDS)) {
    return row as unknown as Operation;
  }
  const spec = OPERATION_FIELDS[kind as Operation['kind']] as Record<
    string,
    Spec
  >;
  for (const [field, tag] of Object.entries(spec)) {
    const wire = row[field];
    if (!tag.startsWith('amount') || wire === undefined) {
      continue;
    }
    if (typeof wire !== 'string') {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        `Stored ${kind}.${field} is not an encoded amount.`,
        { detail: { kind, field } },
      );
    }
    row[field] = decodeCanonicalAmount(wire, `Stored ${kind}.${field}`);
  }
  return row as unknown as Operation;
}

/** One served route. `when` names the option that governs mounting: absent means always,
 *  `webhook`/`instances` mount only when configured, and `reads` unmounts on `reads: false`. */
export type RouteRow = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly summary: string;
  readonly when?: 'webhook' | 'instances' | 'reads';
};

/**
 * The reference host's route registry; the server test holds it against the served table.
 * The `/v1` reads scope by principal — a user token reads only itself — answer under the
 * same limiter as `/submit`, and hand each list page a cursor that resumes it.
 */
export const ROUTES: readonly RouteRow[] = [
  { method: 'GET', path: '/healthz', summary: 'Liveness; touches no storage.' },
  {
    method: 'GET',
    path: '/readyz',
    summary: 'Readiness via one cheap store-touching read.',
  },
  {
    method: 'POST',
    path: '/submit',
    summary: 'Run one operation; a rejection is a 200 with the decline.',
  },
  {
    method: 'POST',
    path: '/webhooks/{provider}',
    summary: 'Verified provider callback into the inbox.',
    when: 'webhook',
  },
  {
    method: 'POST',
    path: '/instances/{scope}/purchase',
    summary: 'One in-world purchase on the scope’s fast lane.',
    when: 'instances',
  },
  {
    method: 'GET',
    path: '/v1/wallet',
    summary: 'The three balances plus payableNow; zeros never 404.',
    when: 'reads',
  },
  {
    method: 'GET',
    path: '/v1/entitlements',
    summary: 'Non-revoked grants, expired included, by sku; ?cursor= resumes.',
    when: 'reads',
  },
  {
    method: 'GET',
    path: '/v1/subscriptions',
    summary:
      'Every subscription, newest first; ?state= filters, ?cursor= resumes.',
    when: 'reads',
  },
  {
    method: 'GET',
    path: '/v1/payouts',
    summary: 'Payout sagas, newest first; ?state= filters, ?cursor= resumes.',
    when: 'reads',
  },
  {
    method: 'GET',
    path: '/v1/rates',
    summary: 'The buy, par, and payout rates in force.',
    when: 'reads',
  },
  {
    method: 'GET',
    path: '/v1/catalog',
    summary: 'The top-up bundles; skus stay host-owned and dynamic.',
    when: 'reads',
  },
  {
    method: 'GET',
    path: '/v1/posting/{txnId}',
    summary: 'One committed posting; a user sees it only if touched.',
    when: 'reads',
  },
];

const AMOUNT_SCHEMA = {
  type: 'string',
  pattern: '^(CREDIT|USD):-?\\d+\\.\\d{2}$',
  description: 'A currency-tagged decimal string.',
} as const;

function fieldSchema(spec: Spec): Record<string, unknown> {
  const base = (spec.endsWith('?') ? spec.slice(0, -1) : spec) as BaseSpec;
  switch (base) {
    case 'string':
      return { type: 'string' };
    case 'int':
      return { type: 'integer' };
    case 'boolean':
      return { type: 'boolean' };
    case 'amount':
      return { ...AMOUNT_SCHEMA };
    case 'recipients':
      return {
        type: 'array',
        items: {
          type: 'object',
          required: ['sellerId', 'shareBps'],
          properties: {
            sellerId: { type: 'string' },
            shareBps: { type: 'integer' },
          },
        },
      };
    case 'object':
      return { type: 'object' };
  }
}

function operationSchemasOf(): Record<string, unknown> {
  const operationSchemas: Record<string, unknown> = {};
  for (const [kind, rows] of Object.entries(FIELDS)) {
    const properties: Record<string, unknown> = {
      kind: { const: kind },
      idempotencyKey: { type: 'string' },
      actor: { $ref: '#/components/schemas/Principal' },
    };
    const required = ['kind', 'idempotencyKey'];
    for (const [field, spec] of Object.entries(rows) as [string, Spec][]) {
      properties[field] = fieldSchema(spec);
      if (!spec.endsWith('?')) required.push(field);
    }
    operationSchemas[`Op_${kind}`] = {
      type: 'object',
      required,
      properties,
      description:
        'With an authenticate function configured, the server stamps `actor` from the bearer and refuses a body that carries its own.',
    };
  }
  return operationSchemas;
}

/**
 * The OpenAPI 3.1 document, generated from FIELDS, the rejection catalog, and the route
 * registry. Deterministic for a given source tree: the snapshot test pins it.
 */
export function buildOpenApi(): Record<string, unknown> {
  const operationSchemas = operationSchemasOf();
  return {
    openapi: '3.1.0',
    info: {
      title: '@pwngh/economy-lab reference host',
      version: '1',
      description:
        'Generated from the wire contract (FIELDS + REJECTION_SPEC + ROUTES). Amounts are currency-tagged decimal strings; a business "no" is a 200 rejected outcome, never an error status.',
    },
    paths: Object.fromEntries(
      ROUTES.map((route) => [
        route.path,
        { [route.method.toLowerCase()]: pathItemOf(route, operationSchemas) },
      ]),
    ),
    components: { schemas: componentSchemasOf(operationSchemas) },
  };
}

// The read family's query vocabulary. The state enums ride the source unions, so the
// document cannot drift from what the server accepts.
const USER_ID_PARAM = {
  name: 'userId',
  in: 'query',
  required: false,
  schema: { type: 'string' },
  description:
    'The subject. A user token reads only itself; system and operator tokens name any user.',
} as const;

const LIMIT_PARAM = {
  name: 'limit',
  in: 'query',
  required: false,
  schema: { type: 'integer' },
  description:
    'Page size. A bad or missing value collapses to the default (50); an oversized ask caps at the ceiling (200).',
} as const;

const CURSOR_PARAM = {
  name: 'cursor',
  in: 'query',
  required: false,
  schema: { type: 'string' },
  description:
    "The previous page's `cursor`, resuming after its last row. Opaque: pass it back unread. Absent starts at the top of the list, and a token from another list answers 400.",
} as const;

const stateParam = (states: readonly string[]): Record<string, unknown> => ({
  name: 'state',
  in: 'query',
  required: false,
  schema: { type: 'string', enum: [...states] },
  description: 'Narrows the list to one state; an unknown value answers 400.',
});

const QUERY_PARAMS: Record<string, ReadonlyArray<Record<string, unknown>>> = {
  '/v1/wallet': [USER_ID_PARAM],
  '/v1/entitlements': [USER_ID_PARAM, LIMIT_PARAM, CURSOR_PARAM],
  '/v1/subscriptions': [
    USER_ID_PARAM,
    stateParam(SUBSCRIPTION_STATES),
    LIMIT_PARAM,
    CURSOR_PARAM,
  ],
  '/v1/payouts': [
    USER_ID_PARAM,
    stateParam(SAGA_STATES),
    LIMIT_PARAM,
    CURSOR_PARAM,
  ],
};

function pathParamsOf(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((match) => ({
    name: match[1]!,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function pathItemOf(
  route: RouteRow,
  operationSchemas: Record<string, unknown>,
): Record<string, unknown> {
  const parameters = [
    ...pathParamsOf(route.path),
    ...(QUERY_PARAMS[route.path] ?? []),
  ];
  return {
    summary: route.summary,
    ...(route.when === 'reads'
      ? {
          description: 'Mounted unless the host sets `reads: false`; then 404.',
        }
      : route.when !== undefined
        ? {
            description: `Mounted only when the host configures \`${route.when}\`; otherwise 404.`,
          }
        : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    responses:
      route.path === '/submit'
        ? {
            200: {
              description: 'An Outcome envelope.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Outcome' },
                },
              },
            },
          }
        : { 200: { description: 'OK' } },
    ...(route.path === '/submit'
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: Object.keys(operationSchemas).map((k) => ({
                    $ref: `#/components/schemas/${k}`,
                  })),
                },
              },
            },
          },
        }
      : {}),
  };
}

function componentSchemasOf(
  operationSchemas: Record<string, unknown>,
): Record<string, unknown> {
  const rejections = REJECTION_CODES.map((code) => ({
    type: 'object',
    required: ['reason', ...REJECTION_SPEC[code].fields],
    properties: {
      reason: { const: code },
      ...Object.fromEntries(REJECTION_SPEC[code].fields.map((f) => [f, {}])),
    },
  }));
  const principalOf = (key: string, kind: string): Record<string, unknown> => ({
    type: 'object',
    required: ['kind', key],
    properties: { kind: { const: kind }, [key]: { type: 'string' } },
  });
  return {
    Amount: { ...AMOUNT_SCHEMA },
    Principal: {
      oneOf: [
        principalOf('userId', 'user'),
        principalOf('service', 'system'),
        principalOf('operatorId', 'operator'),
      ],
    },
    RejectionDetail: { oneOf: rejections },
    Outcome: {
      oneOf: [
        {
          type: 'object',
          required: ['status', 'transaction'],
          properties: {
            status: { enum: ['committed', 'duplicate'] },
            transaction: { type: 'object' },
          },
        },
        {
          type: 'object',
          required: ['status', 'reason', 'detail'],
          properties: {
            status: { const: 'rejected' },
            reason: { enum: [...REJECTION_CODES] },
            detail: { $ref: '#/components/schemas/RejectionDetail' },
          },
        },
      ],
    },
    ...operationSchemas,
  };
}
