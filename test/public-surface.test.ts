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

import { test } from 'node:test';

import type { Economy, Worker } from '#src/index.ts';
import type {
  AccountRef,
  Amount,
  Checkpoint,
  EconomyStatus,
  Operation,
  Outcome,
  Posting,
  ProveReport,
  Saga,
  Statement,
  StoredLink,
  SweepInput,
  SweepRun,
} from '#src/index.ts';

// A public method whose parameter or return type the entry does not export is a half-exported API:
// the caller can hold the value but cannot name it. This guard fails to COMPILE the moment any type
// below stops being importable from '#src/index.ts'. Extend it when a new read/public method lands,
// so its I/O types get exported with it. There is no runtime assertion; tsc is the gate.

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type Read = Economy['read'];

export type PublicSurfaceGuards = [
  Expect<Exact<Parameters<Economy['submit']>[0], Operation>>,
  Expect<Exact<Awaited<ReturnType<Economy['submit']>>, Outcome>>,
  Expect<Exact<Awaited<ReturnType<Read['balance']>>, Amount>>,
  Expect<Exact<Awaited<ReturnType<Read['statement']>>, Statement>>,
  Expect<Exact<Awaited<ReturnType<Read['posting']>>, Posting | null>>,
  Expect<Exact<Awaited<ReturnType<Read['saga']>>, Saga | null>>,
  Expect<Exact<ReturnType<Read['status']>, EconomyStatus>>,
  Expect<Exact<ReturnType<Read['accounts']>, AsyncIterable<AccountRef>>>,
  Expect<Exact<ReturnType<Read['payouts']>, AsyncIterable<Saga>>>,
  Expect<Exact<ReturnType<Read['postings']>, AsyncIterable<Posting>>>,
  Expect<Exact<ReturnType<Read['lineage']>, AsyncIterable<StoredLink>>>,
  Expect<Exact<Awaited<ReturnType<Read['checkpoint']>>, Checkpoint | null>>,
  Expect<Exact<Awaited<ReturnType<Read['prove']>>, ProveReport>>,
  Expect<Exact<Parameters<Worker['runOnce']>[0], SweepInput>>,
  Expect<Exact<Awaited<ReturnType<Worker['runOnce']>>, SweepRun>>,
];

test('public entry names every Economy.read and Worker I/O type (enforced at typecheck)', () => {});
