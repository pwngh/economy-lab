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

import { describe, test as nodeTest, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { countedCases } from './cases.js';
import { ERROR_CODES } from '@pwngh/economy-lab';

import type { RatePolicy } from '@pwngh/economy-lab/adapters';
import type { RateLimiter, RateVerdict } from '@pwngh/economy-lab/ports';

/**
 * What a {@link RateLimiter} conformance run needs from the host. `make` builds a limiter over one
 * policy; the suite calls it many times and never closes what it gets back, so the harness owns
 * every connection it opened and releases them in `close`.
 *
 * `elapse` is the member that makes the suite portable. A limiter measures its window against
 * whatever clock it was built on — an injected one in process, Redis's own key expiry over the
 * wire — and only the harness knows which. It must let **at least** `ms` of that clock pass: a
 * harness over real time may sleep a little longer to cover the round trip, and one over an
 * injected clock advances it exactly.
 */
export interface RateLimiterHarness {
  make(policy: RatePolicy): Promise<RateLimiter> | RateLimiter;

  elapse(ms: number): Promise<void>;

  close?(): Promise<void>;
}

// Long enough that no case waits it out, so the counting cases never sleep.
const LONG_WINDOW_MS = 60_000;

// Short enough to sit out inside a test against a real clock, which is how the two recovery cases
// observe a window reopening rather than reasoning about it.
const SHORT_WINDOW_MS = 300;

/** A key nothing else has counted. Every limiter in a run may share one backend. */
function freshKey(): string {
  return `conf_${randomUUID().slice(0, 8)}`;
}

/** 'allowed', or a denial reduced to whether its wait falls inside the window it names. */
function verdictOf(verdict: RateVerdict, windowMs: number): string {
  if (verdict.allowed) {
    return 'allowed';
  }
  const wait = verdict.retryAfterMs ?? 0;
  return wait > 0 && wait <= windowMs
    ? 'denied for a wait inside the window'
    : `denied for a wait of ${JSON.stringify(verdict.retryAfterMs)}`;
}

async function verdicts(
  limiter: RateLimiter,
  key: string,
  calls: number,
  windowMs: number,
): Promise<string[]> {
  const seen: string[] = [];
  for (let call = 0; call < calls; call += 1) {
    seen.push(verdictOf(await limiter.allow(key), windowMs));
  }
  return seen;
}

const ALLOWED = 'allowed';
const DENIED = 'denied for a wait inside the window';

/**
 * Every policy a limiter must take and every policy it must refuse, in one table. Both directions
 * are here because a refusal case on its own is satisfied by a limiter that refuses everything, and
 * an acceptance case on its own is satisfied by one that refuses nothing.
 *
 * The refused rows are the states that silently disable admission control rather than failing:
 * a zero or negative window arms no expiry, and a fractional or `NaN` one is refused by Redis per
 * call, which the edge turns into fail-open. A zero limit is accepted, and means no calls per
 * window.
 */
const POLICIES: ReadonlyArray<{
  label: string;
  policy: RatePolicy;
  accepted: boolean;
}> = [
  {
    label: 'a hundred calls a minute',
    policy: { limit: 100, windowMs: LONG_WINDOW_MS },
    accepted: true,
  },
  {
    label: 'one call per millisecond, the tightest window there is',
    policy: { limit: 1, windowMs: 1 },
    accepted: true,
  },
  {
    label: 'a zero limit, which is no calls per window',
    policy: { limit: 0, windowMs: LONG_WINDOW_MS },
    accepted: true,
  },
  {
    label: 'a zero window, which arms no expiry',
    policy: { limit: 1, windowMs: 0 },
    accepted: false,
  },
  {
    label: 'a negative window',
    policy: { limit: 1, windowMs: -1 },
    accepted: false,
  },
  {
    label: 'a fractional window',
    policy: { limit: 1, windowMs: 1.5 },
    accepted: false,
  },
  {
    label: 'a NaN window',
    policy: { limit: 1, windowMs: Number.NaN },
    accepted: false,
  },
  {
    label: 'a negative limit',
    policy: { limit: -1, windowMs: LONG_WINDOW_MS },
    accepted: false,
  },
  {
    label: 'a fractional limit',
    policy: { limit: 1.5, windowMs: LONG_WINDOW_MS },
    accepted: false,
  },
];

async function countsEachKeyAgainstItsOwnBudget(
  harness: RateLimiterHarness,
): Promise<void> {
  const limiter = await harness.make({ limit: 1, windowMs: LONG_WINDOW_MS });
  const spent = freshKey();
  const untouched = freshKey();

  assert.deepEqual(await verdicts(limiter, spent, 2, LONG_WINDOW_MS), [
    ALLOWED,
    DENIED,
  ]);
  assert.deepEqual(await verdicts(limiter, untouched, 1, LONG_WINDOW_MS), [
    ALLOWED,
  ]);
}

async function allowsExactlyTheLimitThenDenies(
  harness: RateLimiterHarness,
): Promise<void> {
  const limiter = await harness.make({ limit: 3, windowMs: LONG_WINDOW_MS });
  const key = freshKey();

  // Written out rather than counted, so a limiter off by one on either side of the boundary fails
  // on which call diverged.
  assert.deepEqual(await verdicts(limiter, key, 5, LONG_WINDOW_MS), [
    ALLOWED,
    ALLOWED,
    ALLOWED,
    DENIED,
    DENIED,
  ]);
}

async function deniesEveryCallUnderAZeroLimit(
  harness: RateLimiterHarness,
): Promise<void> {
  const limiter = await harness.make({ limit: 0, windowMs: LONG_WINDOW_MS });
  const key = freshKey();

  // A limiter that decides the first call in a window before comparing it against the limit lets
  // one call per window through here, and reads as correct at every limit above zero.
  assert.deepEqual(await verdicts(limiter, key, 3, LONG_WINDOW_MS), [
    DENIED,
    DENIED,
    DENIED,
  ]);
}

/**
 * A denial's `retryAfterMs` is a wait that elapses. This is the property a lost round trip broke on
 * the Redis limiter: the key kept counting with no expiry, every later call was denied, and the
 * `retryAfterMs` it reported was a full window that no amount of waiting cleared.
 *
 * Exported so `test/conformance-contract.test.ts` can run it against a limiter wedged exactly that
 * way and watch it refuse.
 */
export async function waitsOutTheReportedRetry(
  harness: RateLimiterHarness,
): Promise<void> {
  const limiter = await harness.make({ limit: 1, windowMs: SHORT_WINDOW_MS });
  const key = freshKey();

  assert.deepEqual(await limiter.allow(key), { allowed: true });
  const denied = await limiter.allow(key);
  assert.equal(denied.allowed, false);
  const wait = denied.retryAfterMs ?? 0;
  assert.ok(
    wait > 0 && wait <= SHORT_WINDOW_MS,
    `retryAfterMs was ${JSON.stringify(denied.retryAfterMs)}, outside the window it names`,
  );

  await harness.elapse(wait);

  assert.deepEqual(
    await limiter.allow(key),
    { allowed: true },
    'the wait the denial reported did not clear it',
  );
}

/**
 * No state a limiter reaches is one it cannot leave. Hammering a key far past its limit is what
 * strands a counter that is only armed on the call that created it, so the recovery is asserted
 * from deep inside the denial rather than from the first denial.
 *
 * Exported for the same reason as {@link waitsOutTheReportedRetry}.
 */
export async function leavesEveryStateItReaches(
  harness: RateLimiterHarness,
): Promise<void> {
  const limiter = await harness.make({ limit: 2, windowMs: SHORT_WINDOW_MS });
  const key = freshKey();

  const hammered = await verdicts(limiter, key, 8, SHORT_WINDOW_MS);
  assert.deepEqual(hammered, [
    ALLOWED,
    ALLOWED,
    DENIED,
    DENIED,
    DENIED,
    DENIED,
    DENIED,
    DENIED,
  ]);

  await harness.elapse(SHORT_WINDOW_MS);

  assert.deepEqual(
    await verdicts(limiter, key, 2, SHORT_WINDOW_MS),
    [ALLOWED, ALLOWED],
    'the whole budget is back once the window has passed',
  );
}

async function refusesAPolicyItCannotHonour(
  harness: RateLimiterHarness,
): Promise<void> {
  const observed: Array<[string, string]> = [];
  for (const row of POLICIES) {
    try {
      // Awaited inside the try, because a limiter may refuse synchronously or reject.
      await harness.make(row.policy);
      observed.push([row.label, 'accepted']);
    } catch (error) {
      const code = (error as { code?: string }).code;
      observed.push([
        row.label,
        code === ERROR_CODES.CONFIG_INVALID
          ? 'refused'
          : `threw ${String(code)}`,
      ]);
    }
  }

  assert.deepEqual(
    observed,
    POLICIES.map((row) => [row.label, row.accepted ? 'accepted' : 'refused']),
  );
  assert.equal(observed.length, POLICIES.length);
  assert.equal(POLICIES.length, 9);
}

/**
 * Registers the shared {@link RateLimiter} contract every implementation must satisfy — the same
 * cases the in-process and Redis limiters run — so a host's own limiter cannot silently diverge at
 * the HTTP edge. Written for `node --test`, and called at the top level of a test file.
 *
 * It covers what the port's two-line surface leaves implicit: a key's budget is its own, the limit
 * is the exact number of calls a window allows, a zero limit allows none, a denial's `retryAfterMs`
 * is a wait that genuinely elapses, no state the limiter reaches is one it cannot leave, and a
 * policy no limiter can honour is refused at construction rather than by allowing everything.
 *
 * The harness is built once in a `before` hook. If it throws, every case skips naming the reason
 * instead of failing — the same connect-or-skip contract `runStoreConformance` keeps, so this can
 * sit in a job with no Redis provisioned.
 *
 * @example
 * import { runRateLimiterConformance } from '@pwngh/economy-conformance';
 * import { myRateLimiter } from './my-rate-limiter.js';
 *
 * runRateLimiterConformance('my-limiter', () => ({
 *   make: (policy) => myRateLimiter(policy),
 *   elapse: (ms) => new Promise((done) => setTimeout(done, ms + 25)),
 * }));
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   how the server keys requests and answers a denial.
 */
export function runRateLimiterConformance(
  name: string,
  makeHarness: () => Promise<RateLimiterHarness> | RateLimiterHarness,
): void {
  describe(`RateLimiter Conformance: ${name}`, () => {
    const test = countedCases('runRateLimiterConformance', 7, (name, body) =>
      nodeTest(name, body),
    );

    let harness: RateLimiterHarness | null = null;
    let unreachable = 'limiter unavailable';

    before(async () => {
      try {
        harness = await makeHarness();
      } catch (error) {
        harness = null;
        unreachable = `limiter unavailable: ${error instanceof Error && error.message !== '' ? error.message : String(error)}`;
      }
    });
    after(async () => {
      await harness?.close?.();
    });

    const withHarness = (
      t: TestContext,
      body: (h: RateLimiterHarness) => Promise<void>,
    ): Promise<void> | void =>
      harness ? body(harness) : t.skip(`${name} ${unreachable}`);

    test('counts each key against its own budget', (t) =>
      withHarness(t, countsEachKeyAgainstItsOwnBudget));
    test('allows exactly the limit inside one window and denies past it', (t) =>
      withHarness(t, allowsExactlyTheLimitThenDenies));
    test('denies every call under a zero limit', (t) =>
      withHarness(t, deniesEveryCallUnderAZeroLimit));
    test('the wait a denial reports is one that elapses', (t) =>
      withHarness(t, waitsOutTheReportedRetry));
    test('leaves every state it reaches once the window has passed', (t) =>
      withHarness(t, leavesEveryStateItReaches));
    test('refuses a policy it cannot honour, and takes the ones it can', (t) =>
      withHarness(t, refusesAPolicyItCannotHonour));
  });
}
