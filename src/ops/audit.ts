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

import { GENESIS_HEX } from '#src/ledger.ts';
import { toHex } from '#src/bytes.ts';

import type { Digest } from '#src/ports.ts';

/** The twelve incident signatures the supervisor detects; every audit record names one. */
export type SignatureName =
  | 'deadlock-storm'
  | 'stuck-saga'
  | 'integrity-mismatch'
  | 'engine-stall'
  | 'treasury-breach'
  | 'velocity-anomaly'
  | 'signal-silence'
  | 'retry-exhaustion'
  | 'outbox-backlog'
  | 'webhook-replay-storm'
  | 'checkpoint-seal-slow'
  | 'inbox-dead-letter';

/**
 * Where in an episode a record sits. Tier-1 episodes walk detected, decided, acted, verified;
 * `decided` also records a suppressed action with its reason (cooldown, containment, prior
 * escalation, no lever). `escalated` marks the hand-off to a human, and is the terminal phase
 * a capped or tier-3 episode reaches.
 */
export type AuditPhase =
  | 'detected'
  | 'decided'
  | 'acted'
  | 'verified'
  | 'escalated';

/**
 * One audit entry. Tier 1 means a guarded lever exists for the signature; tier 3 means the
 * supervisor only reports or escalates. `subject` narrows the record to one saga id or watched
 * signal name, null when the episode is composition-wide. `detail` carries the evidence and
 * can hold bigint amounts — the JSONL sinks encode those as `{"$bigint":"..."}`.
 */
export type AuditRecord = {
  at: number;
  signature: SignatureName;
  tier: 1 | 3;
  phase: AuditPhase;
  subject: string | null;
  detail: Record<string, unknown>;
};

/**
 * The host-injected consumer of audit records, called synchronously with each record as the
 * tick emits it. A thrown error propagates out of the tick.
 */
export type AuditSink = (record: AuditRecord) => void;

// Prove reports carry bigint money fields JSON.stringify refuses; they encode as
// `{"$bigint":"..."}`, the same convention as the lab's operation journal.
const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? { $bigint: value.toString() } : value;

/**
 * A sink writing one JSON line per record, bigints encoded as `{"$bigint":"..."}` — the same
 * convention as the lab's operation journal, so one decoder reads both. `write` receives the
 * line without a trailing newline; the caller owns line separation.
 */
export function jsonlAuditSink(write: (line: string) => void): AuditSink {
  return (record) => {
    write(JSON.stringify(record, replacer));
  };
}

const ENCODER = new TextEncoder();

const HASH_SUFFIX = /^(\{.*),"hash":"([0-9a-f]{64})"\}$/s;

/**
 * The tamper-evident sink: each line carries `prev` (the prior line's hash; the first carries
 * the all-zero genesis) and `hash` over everything before it, the same fixed-preimage
 * discipline the ledger's own chain uses. Editing, dropping, or reordering any line breaks the
 * chain at that line for {@link verifyAuditChain}. The digest is async while the sink is not,
 * so records queue on an internal chain that computes and writes strictly in order; `flush`
 * awaits it (call before process exit).
 *
 * @example
 * const lines: string[] = [];
 * const audit = hashChainedAuditSink((line) => lines.push(line), ports.digest);
 * const supervisor = createSupervisor({ ...supervisorPorts, audit });
 * await supervisor.tick();
 * await audit.flush();
 * const report = await verifyAuditChain(lines, ports.digest);
 * // report.intact === true; edit any line and firstBreak names it
 */
export function hashChainedAuditSink(
  write: (line: string) => void,
  digest: Digest,
): AuditSink & { flush: () => Promise<void> } {
  let prev = GENESIS_HEX;
  let tail: Promise<void> = Promise.resolve();
  const sink = (record: AuditRecord): void => {
    tail = tail.then(async () => {
      const body = JSON.stringify(
        {
          prev,
          at: record.at,
          signature: record.signature,
          tier: record.tier,
          phase: record.phase,
          subject: record.subject,
          detail: record.detail,
        },
        replacer,
      );
      const hash = toHex(await digest.hash(ENCODER.encode(body)));
      prev = hash;
      write(`${body.slice(0, -1)},"hash":"${hash}"}`);
    });
  };
  return Object.assign(sink, { flush: () => tail });
}

/** What {@link verifyAuditChain} reports; mirrors the ledger prover's report shape. */
export type AuditChainReport = {
  intact: boolean;
  firstBreak: {
    /** 1-indexed line number of the first record that fails. */
    line: number;
    reason: 'malformed' | 'broken-link' | 'tampered-hash';
  } | null;
  /** Records verified before the break (all of them when intact). */
  count: number;
};

/**
 * Re-derives a {@link hashChainedAuditSink} trail: every line's `hash` must recompute over its
 * own bytes and its `prev` must name the prior line's hash. The preimage is the literal line
 * text minus its hash suffix, so verification needs no re-serialization to agree with the
 * writer. Stops at the first break: `count` is how many records verified before it, and
 * nothing after the break is checked. `make audit-verify FILE=<jsonl>` runs this over a trail
 * file from the command line.
 *
 * @example
 * const lines = trail.trimEnd().split('\n');
 * const report = await verifyAuditChain(lines, ports.digest);
 * if (!report.intact) {
 *   // e.g. { intact: false, firstBreak: { line: 7, reason: 'tampered-hash' }, count: 6 }
 * }
 */
export async function verifyAuditChain(
  lines: ReadonlyArray<string>,
  digest: Digest,
): Promise<AuditChainReport> {
  let prev = GENESIS_HEX;
  let count = 0;
  for (const [index, line] of lines.entries()) {
    const breakAt = (
      reason: 'malformed' | 'broken-link' | 'tampered-hash',
    ): AuditChainReport => ({
      intact: false,
      firstBreak: { line: index + 1, reason },
      count,
    });
    const match = HASH_SUFFIX.exec(line);
    if (match === null) {
      return breakAt('malformed');
    }
    let parsed: { prev?: unknown };
    try {
      parsed = JSON.parse(line) as { prev?: unknown };
    } catch {
      return breakAt('malformed');
    }
    if (parsed.prev !== prev) {
      return breakAt('broken-link');
    }
    const body = `${match[1]}}`;
    const hash = toHex(await digest.hash(ENCODER.encode(body)));
    if (hash !== match[2]) {
      return breakAt('tampered-hash');
    }
    prev = hash;
    count += 1;
  }
  return { intact: true, firstBreak: null, count };
}
