/**
 * @pwngh/economy-cli
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import type { Capabilities, Knob } from '@pwngh/economy-core';
import type {
  BootPosture,
  EconomyTruth,
  Lint,
  PolicyRow,
} from '@pwngh/economy-core/module';

type PreflightIssue = EconomyTruth['preflight'][number];

export interface ExplainReport {
  readonly file: string;
  readonly seams: readonly { name: string; present: boolean }[];
  readonly posture: string;
  readonly adapters: Record<string, unknown>;
  readonly policy: readonly PolicyRow[];
  readonly knobs: readonly Knob[];
  readonly worker: {
    readonly enabled: boolean;
    readonly sweeps: readonly string[];
  };
  /** Every posture the CLI can boot, each with the verdict its own boot reaches. */
  readonly postures: readonly BootPosture[];
  /** Whether a `.env` was in place for the load, so the report states its environment. */
  readonly envFile: boolean;
  /** The floor calls the module compiles to, present when `--desugar` rode `--json`. */
  readonly desugar?: string;
  readonly lints: readonly Lint[];
}

/** The report shape `check` prints, projected 1:1 from the compile and the postures beside it. */
export function explainFromTruth(
  p: EconomyTruth,
  postures: readonly BootPosture[],
  envFile = false,
): ExplainReport {
  return {
    file: p.module.file,
    seams: p.seams,
    posture: p.posture,
    adapters: p.adapters,
    policy: p.policy,
    knobs: p.knobs,
    worker: {
      enabled: p.capabilities.worker.enabled,
      sweeps: p.capabilities.worker.jobs,
    },
    postures,
    envFile,
    lints: p.lints,
  };
}

export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
}

export function renderRoutes(c: Capabilities, posture: string): string {
  return [
    `auth      ${posture}`,
    c.routes.length
      ? c.routes.map((r) => `  ${r.method.padEnd(5)} ${r.path}`).join('\n')
      : '  (no network face — the module states no auth posture)',
    `providers ${c.providers.length ? c.providers.join(', ') : 'none'}`,
    `worker    ${c.worker.enabled ? `${c.worker.jobs.length} jobs` : 'disabled'}`,
  ].join('\n');
}

const adapterKind = (x: unknown): string =>
  typeof x === 'object' && x !== null && 'kind' in x
    ? String((x as { kind: unknown }).kind)
    : String(x);

const adaptersLine = (adapters: Record<string, unknown>): string => {
  const a = adapters as Record<string, { kind?: string } | string | undefined>;
  return (
    `adapters  store ${adapterKind(a.store)} · cache ${adapterKind(a.cache)}` +
    ` · dispatcher ${adapterKind(a.dispatcher)} · processor ${adapterKind(a.processor)}` +
    ` · production ${String(a.production)}`
  );
};

/** Which verbs boot in each posture, so the reader knows which line is about their next command. */
const POSTURE_VERBS: Record<BootPosture['name'], string> = {
  deployed: 'serve, worker',
  dev: 'dev',
};

/**
 * One issue as a block: code and path on the head line, the message indented under it.
 *
 * A preflight remedy is a four-line install-and-pass recipe, and it is what `check` prints at
 * exit 2 — escaped into a JSON object it arrives as one 340-character line nobody can read.
 */
function renderIssue(issue: PreflightIssue): string {
  const i = issue as {
    code: string;
    path: string;
    message: string;
    severity?: string;
  };
  const lines = i.message.split('\n');
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  return [
    `  ${i.code}  ${i.path}${i.severity && i.severity !== 'error' ? ` (${i.severity})` : ''}`,
    ...lines.map((line) => (line.trim() === '' ? '' : `      ${line}`)),
  ].join('\n');
}

const sameVerdict = (a: BootPosture, b: BootPosture): boolean =>
  toJson(a.preflight) === toJson(b.preflight);

/** One row per posture, or one row for all of them when the verdicts agree. */
function renderPostures(postures: readonly BootPosture[]): string[] {
  const head = postures[0];
  if (head === undefined) return [];
  const block = (issues: readonly PreflightIssue[], label: string): string[] =>
    issues.length
      ? [
          `preflight ${label} — ${issues.length} issue(s):`,
          ...issues.map(renderIssue),
        ]
      : [`preflight ${label} — clean`];
  if (postures.every((p) => sameVerdict(p, head))) {
    return block(
      head.preflight,
      postures.length === 1
        ? `${head.name} (economy ${POSTURE_VERBS[head.name]})`
        : `${postures.map((p) => p.name).join(' and ')} agree`,
    );
  }
  return postures.flatMap((p) =>
    block(p.preflight, `${p.name} (economy ${POSTURE_VERBS[p.name]})`),
  );
}

export function renderExplain(r: ExplainReport): string {
  const overridden = r.policy.filter((p) => p.source !== 'default');
  const lines = [
    `module    ${r.file}`,
    `seams     ${r.seams.map((s) => (s.present ? s.name : `(${s.name})`)).join(' ')}   — (parens = absent)`,
    `auth      ${r.posture}`,
    adaptersLine(r.adapters),
    `worker    ${r.worker.enabled ? `${r.worker.sweeps.length} sweeps` : 'disabled (`worker: false`)'}`,
    'knobs     (provenance: definition > flag > env > default)',
    ...r.knobs.map(
      (k) => `  ${k.key.padEnd(20)} ${String(k.value).padEnd(8)} ${k.source}`,
    ),
    `policy    ${
      !r.policy.length
        ? 'unavailable — see preflight'
        : overridden.length
          ? '(module and env rows; the rest sit at defaults — --json prints all)'
          : 'all defaults (--json prints the full table)'
    }`,
    ...overridden.map(
      (p) => `  ${p.key.padEnd(28)} ${p.value.padEnd(12)} ${p.source}`,
    ),
    ...(r.envFile
      ? [
          'env       .env in place for this reading — the environment every verb runs under; a name already set wins',
        ]
      : []),
    ...renderPostures(r.postures),
    r.lints.length
      ? `lints     ${r.lints.length}:\n${r.lints.map((l) => `  ${l.name.padEnd(26)} ${l.message}`).join('\n')}`
      : 'lints     none',
  ];
  return lines.join('\n');
}
