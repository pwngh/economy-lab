/**
 * @pwngh/economy-test
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import type {
  Amount,
  Economy,
  Outcome,
  Operation,
  Saga,
} from '@pwngh/economy-lab';
import { CLIENT_IP_HEADER } from '@pwngh/economy-lab/server';
import type { SweepRun } from '@pwngh/economy-lab/worker';
import type { App } from '@pwngh/economy-core';
import { operatorActor, systemActor, userActor } from '@pwngh/economy-auth';
import type { Principal } from '@pwngh/economy-auth';
import {
  idempotencyKey,
  isRejection,
  reversePayout,
  settlePayout,
} from '@pwngh/economy-core/ops';
import { OWN_SUBJECT } from '@pwngh/economy-core/module';
import type { EconomyModule, OperationDraft } from '@pwngh/economy-core/module';
import { devGrammar } from './dev-grammar.js';
import { testApp } from './testapp.js';
import type { TestClock, TestEconomyOptions } from './testapp.js';

export interface SagaHandle {
  readonly id: string;
  state(): Promise<Saga['state'] | null>;
}

export interface OutcomeHandle {
  readonly outcome: Outcome;
  /** Present when the accepted transaction opened a payout saga (`meta.sagaId`). */
  readonly saga: SagaHandle | null;
}

export interface Persona {
  readonly principal: Principal;
  /** The deterministic dev bearer this principal answers to: `dev_<kind>_<label>`. */
  readonly token: string;
  submit(draft: OperationDraft): Promise<OutcomeHandle>;
  request(path: string, init?: RequestInit): Promise<Response>;
  wallet(): ReturnType<Economy['read']['wallet']>;
}

export interface TestRail {
  /** `manual` waits for `settle`/`fail`; `auto-settle` settles every SUBMITTED saga on tick. */
  mode: 'manual' | 'auto-settle';
  settle(payout: OutcomeHandle | SagaHandle | string): Promise<OutcomeHandle>;
  fail(payout: OutcomeHandle | SagaHandle | string): Promise<OutcomeHandle>;
}

export interface TestEconomy {
  readonly app: App;
  readonly economy: Economy;
  readonly clock: TestClock;
  user(id: string): Persona;
  system(service: string): Persona;
  operator(id: string): Persona;
  fund(who: Persona | string, amount: Amount): Promise<OutcomeHandle>;
  readonly rail: TestRail;
  /** Re-checks up to 20 cycles of `clock.advance(31_000)` + tick; throws when still false. */
  until(check: () => boolean | Promise<boolean>): Promise<void>;
  readonly worker: { tick(): Promise<SweepRun> };
  close(): Promise<void>;
}

const userId = (id: string) => (id.startsWith('usr_') ? id : `usr_${id}`);
const label = (p: Principal) =>
  p.kind === 'user'
    ? p.userId.replace(/^usr_/, '')
    : p.kind === 'system'
      ? p.service
      : p.operatorId.replace(/^ops_/, '');

/** Runs a definition on deterministic ports, with personas that carry their own
 *  credentials. Nothing listens; time passes through `clock.advance`. */
export async function openTestEconomy(
  definition: EconomyModule | Record<string, unknown>,
  options: TestEconomyOptions = {},
): Promise<TestEconomy> {
  const raw =
    'file' in definition && 'exports' in definition
      ? Object.fromEntries(
          (definition as { exports: readonly string[] }).exports.map((k) => [
            k,
            (definition as Record<string, unknown>)[k],
          ]),
        )
      : { ...(definition as Record<string, unknown>) };
  // The dev grammar goes in only when the definition states no posture; a stated one stands.
  if (raw.authenticate === undefined) raw.authenticate = devGrammar;
  const base = await testApp(raw, options);
  const economy = base.economy;

  let seq = 0;
  const nextKey = () => idempotencyKey('persona', String((seq += 1)));
  const handleOf = (outcome: Outcome): OutcomeHandle => {
    const meta = isRejection(outcome)
      ? undefined
      : (outcome.transaction as { meta?: { sagaId?: string } }).meta;
    const sagaId = meta?.sagaId;
    return {
      outcome,
      saga:
        sagaId === undefined
          ? null
          : {
              id: sagaId,
              state: async () =>
                (await economy.read.saga(sagaId))?.state ?? null,
            },
    };
  };

  const persona = (principal: Principal): Persona => ({
    principal,
    token: `dev_${principal.kind}_${label(principal)}`,
    async submit(draft) {
      const d = draft as Record<string, unknown> & { kind: Operation['kind'] };
      const field = OWN_SUBJECT[d.kind];
      const own =
        field && d[field] === undefined
          ? {
              [field]: principal.kind === 'user' ? principal.userId : undefined,
            }
          : {};
      if (field && d[field] === undefined && principal.kind !== 'user') {
        throw new Error(
          `${d.kind} needs ${field} — only a user persona infers its own`,
        );
      }
      const op = { idempotencyKey: nextKey(), actor: principal, ...d, ...own };
      return handleOf(await economy.submit(op as unknown as Operation));
    },
    request: (path, init) => {
      // Headers, not a spread: `{...new Headers(...)}` is `{}`, so a spread merge would
      // silently drop every header passed as a Headers instance or a tuple array.
      const headers = new Headers(init?.headers);
      if (!headers.has('authorization')) {
        headers.set(
          'authorization',
          `Bearer dev_${principal.kind}_${label(principal)}`,
        );
      }
      if (!headers.has(CLIENT_IP_HEADER)) {
        headers.set(CLIENT_IP_HEADER, '127.0.0.1');
      }
      return base.request(path, { ...init, headers });
    },
    wallet() {
      if (principal.kind !== 'user') {
        throw new Error(
          `wallet() reads a user's wallet; a ${principal.kind} persona has none`,
        );
      }
      return economy.read.wallet(principal.userId);
    },
  });

  const sagaOf = async (
    x: OutcomeHandle | SagaHandle | string,
  ): Promise<Saga> => {
    const id =
      typeof x === 'string' ? x : 'saga' in x ? (x.saga?.id ?? '') : x.id;
    const saga = id ? await economy.read.saga(id) : null;
    if (!saga)
      throw new Error(
        `no saga for ${JSON.stringify(id)} — was the payout accepted?`,
      );
    return saga;
  };
  const railActor = systemActor('rail');
  const rail: TestRail = {
    mode: 'manual',
    async settle(x) {
      const saga = await sagaOf(x);
      return handleOf(
        await economy.submit(
          settlePayout({
            idempotencyKey: nextKey(),
            actor: railActor,
            sagaId: saga.id,
            providerRef: saga.providerRef ?? `rail_${saga.id}`,
          }),
        ),
      );
    },
    async fail(x) {
      const saga = await sagaOf(x);
      return handleOf(
        await economy.submit(
          reversePayout({
            idempotencyKey: nextKey(),
            actor: railActor,
            userId: saga.userId,
            sagaId: saga.id,
            reason: 'rail declined (test)',
            providerReported: true,
          }),
        ),
      );
    },
  };

  const tick = async (): Promise<SweepRun> => {
    const run = await base.tick();
    if (rail.mode === 'auto-settle') {
      const due: string[] = [];
      for await (const s of economy.read.payouts({ states: ['SUBMITTED'] }))
        due.push(s.id);
      for (const id of due) await rail.settle(id);
    }
    return run;
  };

  return {
    app: base.app,
    economy,
    clock: base.clock,
    user: (id) => persona(userActor(userId(id))),
    system: (service) => persona(systemActor(service)),
    operator: (id) =>
      persona(operatorActor(id.startsWith('ops_') ? id : `ops_${id}`)),
    fund(who, amount) {
      const to =
        typeof who === 'string'
          ? userId(who)
          : who.principal.kind === 'user'
            ? who.principal.userId
            : '';
      if (!to) throw new Error('fund() credits a user persona');
      return persona(systemActor('fund')).submit({
        kind: 'topUp',
        userId: to,
        amount,
        source: 'test',
      });
    },
    rail,
    async until(check) {
      for (let cycle = 0; cycle < 20; cycle += 1) {
        if (await check()) return;
        base.clock.advance(31_000);
        await tick();
      }
      if (!(await check()))
        throw new Error('until(): still false after 20 cycles (620 s)');
    },
    worker: { tick },
    close: () => base.close(),
  };
}
