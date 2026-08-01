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

// Every docs↔source chip must point where it says it points. `app/anchors.ts` holds the rule; this
// file pins the population and proves the rule can fail.
//
// The populations are pinned to exact numbers, not floors, because the failures this replaces were
// all failures to look: a chip with no label was never checked past file-exists, an inline chip
// could not carry a label at all, and a whole family was invisible to the collector. A count that
// can only be met by examining everything is what makes those distinguishable from a clean run.
//
// After a source edit this fails until the chips are re-pointed and REPO_REF re-pinned (app/repo.ts).
// The failure text names the line the symbol is actually on, so the repair is the number it prints.

import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  type Chip,
  type Declaration,
  REPO_ROOT,
  type ResolutionContext,
  collectChips,
  defaultContext,
  resolveChip,
} from './anchors';

const inventory = collectChips();
const ctx = defaultContext();

const ranged = inventory.chips.filter((c) => c.start !== null);
const points = ranged.filter((c) => c.start === c.end);
const spans = ranged.filter((c) => c.start !== c.end);
const fileOnly = inventory.chips.filter((c) => c.start === null);
const fileOnlyLabeled = fileOnly.filter((c) => c.label);
const bare = fileOnly.filter((c) => !c.label);
const fromLinkText = inventory.chips.filter((c) => c.labelFrom === 'text');

// A bare chip names a file, no line, no symbol, so the only check it can carry is file-exists.
// What that gives up, stated: the thing the page cites can be renamed out of the file — or the
// file gutted to a stub — and the chip stays green as long as the path resolves. So a chip stays
// bare only where the page's claim genuinely is the artifact and not a symbol inside it, and every
// bare chip is admitted here by page. A page about a symbol names it with `path · symbol`, which
// is checked against the file's declarations without making a line claim.
//
// The kinds, and the fact each one claims:
//   suite     the page cites the file as the witness for its claims, not any one test inside it.
//             Admitted for test/** only.
//   script    the artifact is the command the page tells an operator to run. scripts/** only.
//   opaque    a file kind this gate has no declaration reader for, so a label could not be
//             checked anyway — re-verified against the reader every run.
//   artifact  a readable source file the page cites as a unit; the `why` is the argument, quoting
//             the page's own framing.
const BARE_ADMITTED: ReadonlyArray<{
  page: string;
  path: string;
  kind: 'suite' | 'script' | 'opaque' | 'artifact';
  why?: string;
}> = [
  {
    page: 'economy/concepts/accrual-split.mdx',
    path: 'test/operations/accrual.test.ts',
    kind: 'suite',
  },
  { page: 'economy/concepts/cluster.mdx', path: 'test/cluster.test.ts', kind: 'suite' },
  {
    page: 'economy/concepts/instance-economy.mdx',
    path: 'test/instance.prefund.test.ts',
    kind: 'suite',
  },
  { page: 'economy/concepts/instance-economy.mdx', path: 'test/instance.test.ts', kind: 'suite' },
  {
    page: 'economy/concepts/overview.mdx',
    path: 'test/conformance/invariants.adversarial.test.ts',
    kind: 'suite',
  },
  { page: 'economy/concepts/platform-sharding.mdx', path: 'test/sharding.test.ts', kind: 'suite' },
  { page: 'economy/concepts/session-netting.mdx', path: 'test/netting.test.ts', kind: 'suite' },
  { page: 'economy/concepts/the-proof.mdx', path: 'test/prove.test.ts', kind: 'suite' },
  { page: 'economy/ops/archival.mdx', path: 'test/worker/archive.test.ts', kind: 'suite' },
  { page: 'economy/ops/archival.mdx', path: 'test/worker/retention.test.ts', kind: 'suite' },
  { page: 'economy/ops/threat-model.mdx', path: 'test/server.test.ts', kind: 'suite' },
  { page: 'economy/reference/http-service.mdx', path: 'test/server.test.ts', kind: 'suite' },
  {
    page: 'economy/reference/offline-verification.mdx',
    path: 'test/verify-export.test.ts',
    kind: 'suite',
  },
  { page: 'economy/reference/reads.mdx', path: 'test/economy.read.test.ts', kind: 'suite' },
  {
    page: 'economy/scope-and-non-goals.mdx',
    path: 'test/conformance/invariants.adversarial.test.ts',
    kind: 'suite',
  },
  { page: 'economy/ops/audit-trail.mdx', path: 'scripts/audit-verify.ts', kind: 'script' },
  { page: 'economy/ops/audit-trail.mdx', path: 'scripts/audit-worm.ts', kind: 'script' },
  { page: 'economy/ops/backup-restore.mdx', path: 'scripts/backup.ts', kind: 'script' },
  { page: 'economy/ops/backup-restore.mdx', path: 'scripts/restore-drill.ts', kind: 'script' },
  { page: 'economy/ops/backup-restore.mdx', path: 'scripts/support/db-tools.ts', kind: 'script' },
  {
    page: 'economy/reference/offline-verification.mdx',
    path: 'scripts/ledger-verify.ts',
    kind: 'script',
  },
  { page: 'economy/concepts/overview.mdx', path: 'README.md', kind: 'opaque' },
  { page: 'economy/reference/api.mdx', path: 'package.json', kind: 'opaque' },
  { page: 'economy/reference/configuration.mdx', path: '.env.example', kind: 'opaque' },
  {
    page: 'economy/reference/api.mdx',
    path: 'src/index.ts',
    kind: 'artifact',
    why: 'the page is "a map of the import paths"; the chip cites the main entry file, not a symbol in it',
  },
  {
    page: 'economy/reference/http-service.mdx',
    path: 'economy/app.ts',
    kind: 'artifact',
    why: 'the page cites the file as the unit the CLI mounts — "economy/app.ts is the module"',
  },
  {
    page: 'economy/ports/packages.mdx',
    path: 'src/money-arithmetic.ts',
    kind: 'artifact',
    why: 'the transplant is cited as a whole file — "The lab\'s money is its own source, in two files"',
  },
  {
    page: 'economy/ports/packages.mdx',
    path: 'src/money-sql.ts',
    kind: 'artifact',
    why: 'the second of those two files; the page claims the files, not a symbol inside either',
  },
];

// Re-resolving a chip at a line it was not written at. `resolveChip` reads nothing but the chip,
// so a moved copy is the whole mutation — no file is touched.
const moved = (chip: Chip, start: number, end = start) => resolveChip({ ...chip, start, end }, ctx);

describe('docs↔source anchors resolve against the library tree', () => {
  test(`the inventory reconciles: ${inventory.pages.length} pages, ${inventory.chips.length} chips, none unparsed`, () => {
    // Exact, not a floor. A collector that silently stops seeing a family of chips — which is how
    // six `kind 'topUp'` chips hid behind their own quoting — moves these numbers.
    expect(inventory.pages.length).toBe(76);
    expect(inventory.frontmatterEntries).toBe(230);
    expect(inventory.sourceLinkTags).toBe(57);
    // Every raw hit became a chip: nothing was dropped between the scan and the parse.
    expect(inventory.chips.length).toBe(inventory.frontmatterEntries + inventory.sourceLinkTags);
    expect(inventory.chips.length).toBe(287);
    expect(inventory.unparsed).toEqual([]);
  });

  test(`the checked set: ${ranged.length} chips carry a line range and every one of them names a symbol`, () => {
    expect(ranged.length).toBe(171);
    expect(points.length).toBe(124);
    expect(spans.length).toBe(47);
    // The hole this gate was rewritten to close. A ranged chip with no symbol is unresolvable by
    // construction, so the roster of them is empty rather than exempt.
    expect(ranged.filter((c) => !c.label)).toEqual([]);
    // 29 of them get their symbol from the <SourceLink>'s own text rather than a `· label`, which
    // is what makes an inline chip checkable without changing the `to` grammar.
    expect(fromLinkText.length).toBe(29);
  });

  test(`the exemption: ${fileOnly.length} chips name a file and no line — ${fileOnlyLabeled.length} name a symbol, ${bare.length} are bare and admitted by page`, () => {
    expect(fileOnly.length).toBe(116);
    expect(fileOnlyLabeled.length).toBe(88);
    // Every bare chip is on the roster and every admission still has its chip, in one comparison:
    // a new bare chip has to be argued into BARE_ADMITTED, and an admission whose chip has since
    // gained a label — or left the page — is residue, not an admission.
    const actual = bare.map((c) => `${c.page} → ${c.path}`).sort();
    const admitted = BARE_ADMITTED.map((r) => `${r.page} → ${r.path}`).sort();
    expect(actual).toEqual(admitted);
    expect(bare.length).toBe(28);
  });

  test('each bare admission still holds the fact its kind claims', () => {
    // The kinds re-resolve every run, so a reason cannot outlive its truth: a suite admission is
    // only for test/**, a script admission only for scripts/**, and an opaque admission is only
    // for a file the resolver genuinely has no declaration reader for.
    let examined = 0;
    for (const row of BARE_ADMITTED) {
      examined += 1;
      if (row.kind === 'suite') expect(row.path.startsWith('test/'), `${row.path}`).toBe(true);
      if (row.kind === 'script') expect(row.path.startsWith('scripts/'), `${row.path}`).toBe(true);
      if (row.kind === 'opaque')
        expect(ctx.read(join(REPO_ROOT, row.path)).declarations, row.path).toBeNull();
      if (row.kind === 'artifact') expect(row.why, `${row.path} carries no argument`).toBeTruthy();
    }
    expect(examined).toBe(28);
    expect(BARE_ADMITTED.filter((r) => r.kind === 'suite').length).toBe(15);
    expect(BARE_ADMITTED.filter((r) => r.kind === 'script').length).toBe(6);
    expect(BARE_ADMITTED.filter((r) => r.kind === 'opaque').length).toBe(3);
    expect(BARE_ADMITTED.filter((r) => r.kind === 'artifact').length).toBe(4);
  });

  test(`a correctly aimed chip passes: all ${points.length} point chips land where they are written`, () => {
    // The positive control. "A wrong chip fails" is satisfiable by failing everything, so the gate
    // has to be shown answering yes as well as no — on the real corpus, at a stated size.
    const landing = points.filter((c) => resolveChip(c, ctx) === null);
    expect(landing.length).toBe(124);
  });

  test(`every one of the ${points.length} point chips fails when moved a single line`, () => {
    // Sensitivity on the real tree, not on a fixture: no point chip is resolving for a reason that
    // survives the line number changing.
    const stillGreen = points.flatMap((c) => {
      const start = c.start ?? 0;
      const up = moved(c, start + 1) === null;
      const down = start > 1 && moved(c, start - 1) === null;
      return up || down ? [`${c.page} ${c.raw}`] : [];
    });
    expect(stillGreen).toEqual([]);
  });

  test(`every one of the ${ranged.length} ranged chips fails when re-aimed at line 1`, () => {
    // Line 1 of every source file is the license header, which declares nothing. A chip that still
    // resolved there would be one the gate is not reading the line number of at all.
    const stillGreen = ranged.flatMap((c) => (moved(c, 1) === null ? [`${c.page} ${c.raw}`] : []));
    expect(stillGreen).toEqual([]);
  });

  for (const chip of inventory.chips) {
    const where = chip.labelFrom === 'text' ? ` (label from link text: ${chip.label})` : '';
    test(`${chip.page} → ${chip.raw}${where}`, () => {
      expect(resolveChip(chip, ctx), `${chip.page}:${chip.line}`).toBeNull();
    });
  }
});

// A hand-written file the resolver is pointed at, so the rule is tested against known line numbers
// rather than against whatever the tree happens to hold. Every number below is stated here, not
// derived from the same walk that produced the verdict.
//
//   L10  /** doc comment for sealCheckpoint */     ← a mention, not a declaration
//   L14  export function sealCheckpoint(           ← the declaration
//   L20  }                                          ← end of its body
//   L30  kind: 'topUp'                              ← one variant of a tagged union
//   L40  kind: 'spend'                              ← the next variant
const FIXTURE: Declaration[] = [
  { name: 'sealCheckpoint', line: 14, from: 14, to: 20 },
  { name: 'topUp', line: 30, from: 30, to: 30 },
  { name: 'kind', line: 30, from: 30, to: 30 },
  { name: 'spend', line: 40, from: 40, to: 40 },
  { name: 'kind', line: 40, from: 40, to: 40 },
];

const fixtureCtx: ResolutionContext = {
  repoRoot: '/repo',
  read: (file) =>
    file.endsWith('.sql')
      ? { lines: 100, declarations: [{ name: 'legs_conserve', line: 60, from: 60, to: 60 }] }
      : file.endsWith('.md')
        ? { lines: 100, declarations: null }
        : { lines: 100, declarations: FIXTURE },
  exists: (file) => !file.includes('gone'),
};

const chip = (over: Partial<Chip>): Chip => ({
  page: 'fixture.mdx',
  line: 1,
  form: 'sourceRefs',
  raw: 'fixture',
  path: 'src/fixture.ts',
  start: null,
  end: null,
  label: null,
  labelFrom: null,
  ...over,
});

describe('the rule a chip has to satisfy', () => {
  test('a point chip lands on the declaration and nowhere else', () => {
    expect(
      resolveChip(chip({ start: 14, end: 14, label: 'sealCheckpoint' }), fixtureCtx),
    ).toBeNull();
    // Inside the body is not the declaration: a point claims the symbol is on that line.
    expect(
      resolveChip(chip({ start: 17, end: 17, label: 'sealCheckpoint' }), fixtureCtx),
    ).toContain('declared at L14');
    // The doc comment above it is outside the declaration's extent, on purpose — a chip that drifts
    // up into the doc block is the single most common stale shape in this tree.
    expect(
      resolveChip(chip({ start: 10, end: 10, label: 'sealCheckpoint' }), fixtureCtx),
    ).toContain('does not declare sealCheckpoint');
  });

  test('a span may contain the declaration or sit inside it, and nothing else', () => {
    expect(
      resolveChip(chip({ start: 12, end: 16, label: 'sealCheckpoint' }), fixtureCtx),
    ).toBeNull();
    expect(
      resolveChip(chip({ start: 16, end: 19, label: 'sealCheckpoint' }), fixtureCtx),
    ).toBeNull();
    // Straddling the end: neither containing nor contained.
    expect(
      resolveChip(chip({ start: 18, end: 25, label: 'sealCheckpoint' }), fixtureCtx),
    ).toContain('neither contains nor sits inside');
    expect(resolveChip(chip({ start: 1, end: 9, label: 'sealCheckpoint' }), fixtureCtx)).toContain(
      'neither contains nor sits inside',
    );
  });

  test('a label resolves against its last word, so a short first word cannot carry it', () => {
    // `kind` is declared on both variants; `topUp` on one. Taking the last word is what stops the
    // topUp chip from resolving against the spend variant's `kind`.
    expect(resolveChip(chip({ start: 30, end: 30, label: "kind 'topUp'" }), fixtureCtx)).toBeNull();
    expect(resolveChip(chip({ start: 40, end: 40, label: "kind 'topUp'" }), fixtureCtx)).toContain(
      'does not declare topUp',
    );
    // Same shape for a dotted member: `Economy.read` is a claim about `read`.
    expect(
      resolveChip(chip({ start: 30, end: 30, label: 'Operation.topUp' }), fixtureCtx),
    ).toBeNull();
  });

  test('a symbol the file does not declare is named, not shrugged at', () => {
    expect(resolveChip(chip({ start: 14, end: 14, label: 'notASymbol' }), fixtureCtx)).toContain(
      'declares no notASymbol',
    );
    // The generic link text 12 inline chips used to carry. It resolves against nothing, which is
    // why those twelve now carry a written label instead of an exemption.
    expect(resolveChip(chip({ start: 14, end: 14, label: 'source' }), fixtureCtx)).toContain(
      'declares no source',
    );
    expect(resolveChip(chip({ start: 14, end: 14, label: '404' }), fixtureCtx)).toContain(
      'names no identifier',
    );
  });

  test('a ranged chip with no symbol fails rather than passing unexamined', () => {
    expect(resolveChip(chip({ start: 14, end: 14 }), fixtureCtx)).toContain('names no symbol');
    expect(resolveChip(chip({ start: 14, end: 14, form: 'SourceLink' }), fixtureCtx)).toContain(
      'name the symbol in the link text',
    );
  });

  test('a file-only chip is checked for the file, and for the symbol when it names one', () => {
    expect(resolveChip(chip({}), fixtureCtx)).toBeNull();
    expect(resolveChip(chip({ path: 'src/gone.ts' }), fixtureCtx)).toContain('no such file');
    expect(resolveChip(chip({ label: 'sealCheckpoint' }), fixtureCtx)).toBeNull();
    expect(resolveChip(chip({ label: 'notASymbol' }), fixtureCtx)).toContain(
      'declares no notASymbol',
    );
  });

  test('bounds are checked before symbols', () => {
    expect(
      resolveChip(chip({ start: 90, end: 140, label: 'sealCheckpoint' }), fixtureCtx),
    ).toContain('runs past');
    expect(resolveChip(chip({ start: 0, end: 0, label: 'sealCheckpoint' }), fixtureCtx)).toContain(
      'nonsense range',
    );
  });

  test('a file kind with no declaration reader fails a labeled chip instead of passing it', () => {
    // The widen-rather-than-slip rule: a chip into a file this gate cannot parse is a gap the gate
    // reports, not a chip it waves through.
    expect(
      resolveChip(chip({ path: 'README.md', start: 5, end: 5, label: 'anything' }), fixtureCtx),
    ).toContain('cannot read symbols in');
    // SQL is read: a schema object is declared by the statement that creates it.
    expect(
      resolveChip(
        chip({ path: 'db/schema.sql', start: 60, end: 60, label: 'legs_conserve' }),
        fixtureCtx,
      ),
    ).toBeNull();
    expect(
      resolveChip(
        chip({ path: 'db/schema.sql', start: 59, end: 59, label: 'legs_conserve' }),
        fixtureCtx,
      ),
    ).toContain('declared at L60');
  });
});
