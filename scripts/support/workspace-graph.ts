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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly files?: readonly string[];
  /** npm's two shapes: one command named after the package, or a map of command to file. */
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface Member {
  readonly slug: string;
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly json: Manifest;
}

export type Workspace = ReadonlyMap<string, Member>;

/** What the registry says about one name at one version. */
export type RegistryState = 'published' | 'absent' | 'unknown';

export interface Step {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly action: 'publish' | 'skip' | 'blocked';
  readonly reason: string;
}

const readJson = (path: string): Manifest =>
  JSON.parse(readFileSync(path, 'utf8')) as Manifest;

/** The repository root's own manifest, which is a dependency of the packages but not one of them. */
export function readRootPackage(root: string): Member {
  const json = readJson(join(root, 'package.json'));
  return {
    slug: '.',
    dir: root,
    name: json.name ?? '.',
    version: json.version ?? '0.0.0',
    json,
  };
}

/** Every directory under packages/ that carries a manifest, keyed by published name. */
export function readWorkspace(root: string): Map<string, Member> {
  const dir = join(root, 'packages');
  const members = new Map<string, Member>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const manifest = join(dir, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const json = readJson(manifest);
    const name = json.name ?? entry.name;
    members.set(name, {
      slug: entry.name,
      dir: join(dir, entry.name),
      name,
      version: json.version ?? '0.0.0',
      json,
    });
  }
  return members;
}

// Runtime deps only. A dev dependency is not needed to compile src, and counting it makes a
// cycle out of the ordinary case where a package's tests use a sibling fixture.
export const runtimeDependencies = (
  member: Member,
): Record<string, string> => ({
  ...member.json.dependencies,
  ...member.json.peerDependencies,
});

/** Depth-first, so a package is emitted only after everything it imports. Throws on a cycle. */
export function dependencyOrder(workspace: Workspace): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string, trail: readonly string[]): void => {
    if (done.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`dependency cycle: ${[...trail, name].join(' -> ')}`);
    }
    visiting.add(name);
    for (const dep of Object.keys(runtimeDependencies(workspace.get(name)!))) {
      if (workspace.has(dep)) visit(dep, [...trail, name]);
    }
    visiting.delete(name);
    done.add(name);
    order.push(name);
  };

  for (const name of workspace.keys()) visit(name, []);
  return order;
}

type Triple = readonly [number, number, number];

// A prerelease or build tag is deliberately unreadable here: returning null makes the caller
// say so out loud rather than guess at precedence rules this release never uses.
function parse(version: string): Triple | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const below = (a: Triple, b: Triple): boolean =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

const atLeast = (a: Triple, b: Triple): boolean => !below(a, b);

/** The exclusive upper bound a caret range allows, which narrows as the major digit stays 0. */
function caretCeiling(v: Triple): Triple {
  if (v[0] > 0) return [v[0] + 1, 0, 0];
  if (v[1] > 0) return [0, v[1] + 1, 0];
  return [0, 0, v[2] + 1];
}

/**
 * Whether a version falls in a range, or null when the range is a form this gate does not read.
 * Null is never a pass: the caller reports it and refuses.
 */
export function satisfies(version: string, range: string): boolean | null {
  const v = parse(version);
  if (v === null) return null;
  const spec = range.trim();
  if (spec === '' || spec === '*' || spec === 'x') return true;
  const operator = /^[\^~=]/.exec(spec)?.[0] ?? '';
  const target = parse(spec.slice(operator.length));
  if (target === null) return null;
  if (operator === '^') {
    return atLeast(v, target) && below(v, caretCeiling(target));
  }
  if (operator === '~') {
    return atLeast(v, target) && below(v, [target[0], target[1] + 1, 0]);
  }
  return v[0] === target[0] && v[1] === target[1] && v[2] === target[2];
}

const BLOCKS = ['dependencies', 'peerDependencies'] as const;

interface Reference {
  readonly from: string;
  readonly block: string;
  readonly dep: string;
  readonly range: string;
  readonly known: string;
}

function checkRange({
  from,
  block,
  dep,
  range,
  known,
}: Reference): string | null {
  // A local protocol resolves in the workspace and nowhere else, so a tarball carrying one
  // installs as a broken dependency.
  if (/^(file|link|workspace|portal):/.test(range)) {
    return `${from}: ${block}.${dep} is "${range}", which resolves in the workspace and nowhere else`;
  }
  const ok = satisfies(known, range);
  if (ok === null) {
    return `${from}: cannot compare ${dep}@${known} against ${block}.${dep} "${range}"; check it by hand`;
  }
  if (!ok) {
    return `${from}: ${block}.${dep} wants "${range}", but ${dep} is at ${known}`;
  }
  return null;
}

/**
 * Every cross-reference a release would ship broken: a sibling range naming a version nobody
 * is about to publish. `known` carries versions from outside the workspace, such as the root.
 */
export function crossPackageFindings(
  workspace: Workspace,
  external: ReadonlyMap<string, string> = new Map(),
): string[] {
  const findings: string[] = [];
  for (const member of [...workspace.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    for (const block of BLOCKS) {
      for (const [dep, range] of Object.entries(member.json[block] ?? {})) {
        const known = workspace.get(dep)?.version ?? external.get(dep);
        if (known === undefined) continue;
        const finding = checkRange({
          from: member.name,
          block,
          dep,
          range,
          known,
        });
        if (finding !== null) findings.push(finding);
      }
    }
  }
  return findings;
}

/**
 * Every way the tree has moved out from under a plan since preflight read it. A release that
 * takes minutes is a release the workspace can change during.
 */
export function planDrift(
  plan: readonly Step[],
  workspace: Workspace,
): string[] {
  const findings: string[] = [];
  for (const step of plan) {
    const now = workspace.get(step.name);
    if (now === undefined) {
      findings.push(`${step.name} left the workspace after the plan was made`);
    } else if (now.version !== step.version) {
      findings.push(
        `${step.name} moved from ${step.version} to ${now.version} after the plan was made`,
      );
    }
  }
  const planned = new Set(plan.map((step) => step.name));
  for (const name of workspace.keys()) {
    if (!planned.has(name)) {
      findings.push(`${name} joined the workspace after the plan was made`);
    }
  }
  return findings;
}

const pick = (member: Member) => ({
  name: member.name,
  version: member.version,
  dir: member.dir,
});

/**
 * The walk, one line per package: publish it, skip a version the registry already holds, or
 * refuse to guess when the registry would not say.
 */
export function publishPlan(
  order: readonly string[],
  workspace: Workspace,
  state: ReadonlyMap<string, RegistryState>,
): Step[] {
  return order.map((name) => {
    const member = workspace.get(name)!;
    const seen = state.get(name) ?? 'unknown';
    const at = `${name}@${member.version}`;
    if (seen === 'published') {
      return {
        ...pick(member),
        action: 'skip',
        reason: `${at} is already on the registry`,
      };
    }
    if (seen === 'unknown') {
      return {
        ...pick(member),
        action: 'blocked',
        reason: `the registry would not say whether ${at} exists`,
      };
    }
    return {
      ...pick(member),
      action: 'publish',
      reason: `${at} is not on the registry`,
    };
  });
}
