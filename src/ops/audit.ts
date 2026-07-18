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

export type AuditPhase =
  | 'detected'
  | 'decided'
  | 'acted'
  | 'verified'
  | 'escalated';

export type AuditRecord = {
  at: number;
  signature: SignatureName;
  tier: 1 | 3;
  phase: AuditPhase;
  subject: string | null;
  detail: Record<string, unknown>;
};

export type AuditSink = (record: AuditRecord) => void;

// Prove reports carry bigint money fields JSON.stringify refuses; they encode as
// `{"$bigint":"..."}`, the same convention as the lab's operation journal.
const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? { $bigint: value.toString() } : value;

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
 * writer.
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
