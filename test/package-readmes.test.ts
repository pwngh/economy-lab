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
 * The package-docs gate. Every README and CHANGELOG is product, so every claim in one is
 * checked against the code it describes: the install line names the umbrella, each import in a
 * fenced example resolves through a door and names real exports, each `economy` command
 * names a verb the bin actually dispatches, and each repository path is on disk. A document
 * cannot go stale without failing here.
 *
 * Those all read what a document says. One check reads what it fails to say: every door in the
 * manifest is named in the umbrella README, which is the direction that let the backend split
 * ship undocumented on the front page.
 *
 * All of that is shape. A README can satisfy every line of it and still say the opposite of what
 * the code does, which is how nine false claims shipped past this file. The claim checks at the
 * bottom settle a sentence by running the code it describes: which error an operation throws,
 * which order a gate runs its steps in, which fields a decoder demands.
 *
 * What they do not do is read prose. Three sentence shapes are resolvable here and every other
 * sentence is unread — a count, a comparison, a promise about the future, all of it goes
 * unchecked. The sweep is what keeps that subset honest: it finds every sentence of a resolvable
 * shape in every package README and in every CHANGELOG's undated blocks, and one nobody
 * registered fails the gate rather than passing unread. A dated block is out of the claim
 * surface: it records what a published version did, the code has moved since, and a true record
 * of then is not a false claim about now.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import '#test/support/dist-guard.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = join(ROOT, 'packages');
const NODE_MODULES = join(ROOT, 'node_modules');

interface Pkg {
  readonly dir: string;
  readonly slug: string;
  readonly name: string;
  readonly readme: string;
  readonly changelog: string;
}

/** One document under check, labelled the way its failures should read. */
interface Doc {
  readonly pkg: Pkg;
  readonly label: string;
  readonly text: string;
}

const read = (path: string) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const packages: Pkg[] = readdirSync(PACKAGES, { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() && existsSync(join(PACKAGES, d.name, 'package.json')),
  )
  .map((d) => {
    const dir = join(PACKAGES, d.name);
    const { name } = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    ) as { name: string };
    return {
      dir,
      slug: d.name,
      name,
      readme: read(join(dir, 'README.md')),
      changelog: read(join(dir, 'CHANGELOG.md')),
    };
  });

/**
 * The sections of a CHANGELOG still being written. A heading carrying a date is the record of
 * a publish, and the record is not rewritten when the code moves on.
 */
function undated(md: string): string {
  const lines: string[] = [];
  // Open at the top: the preamble before the first heading makes claims like any section, and
  // starting closed left it — 68 of 690 lines — outside every check below.
  let open = true;
  for (const line of md.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) open = !/\d{4}-\d{2}-\d{2}/.test(heading[1]!);
    if (open) lines.push(line);
  }
  return lines.join('\n');
}

// Both surfaces make the same kind of claim, so both are read by the checks below. A
// CHANGELOG is read down to the blocks still being written.
const docs: Doc[] = packages.flatMap((pkg) => [
  ...(pkg.readme
    ? [{ pkg, label: `${pkg.name} README`, text: pkg.readme }]
    : []),
  ...(pkg.changelog
    ? [{ pkg, label: `${pkg.name} CHANGELOG`, text: undated(pkg.changelog) }]
    : []),
]);

/** Fenced blocks by language tag, in document order. */
function fences(md: string, lang: string): string[] {
  const out: string[] = [];
  const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g');
  for (const m of md.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Inline code spans outside every fence: the prose surface, where a claim is made in words. */
function spans(md: string): string[] {
  const out: string[] = [];
  for (const m of md.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g))
    out.push(m[1]!);
  return out;
}

const isDir = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

// The message names the absent file, because the checks below read the README as content and
// report an empty one as bad content — three complaints about headings that are not there.
test('every package ships a README', () => {
  assert.equal(packages.length, 18, `found ${packages.length} packages`);
  for (const p of packages)
    assert.ok(
      p.readme.length > 0,
      `${p.name}: no README.md at packages/${p.slug}/README.md`,
    );
});

// The CHANGELOG surface is half of what the checks below read, and a slice that took nothing
// would pass every one of them in silence.
test('a CHANGELOG is read down to the blocks still being written', () => {
  const changelogs = docs.filter((d) => d.label.endsWith('CHANGELOG'));
  assert.equal(changelogs.length, 18, `found ${changelogs.length} CHANGELOGs`);
  assert.ok(
    changelogs.some((d) => d.text.length > 0),
    'every CHANGELOG read empty',
  );
  const md = [
    '## Unreleased',
    '- `economy dev` is here.',
    '## 0.1.0 - 2026-07-25',
    '- `economy gone` was here.',
  ].join('\n');
  assert.match(undated(md), /economy dev/);
  assert.doesNotMatch(undated(md), /economy gone/);
});

// A document naming a package we do not ship is a promise the reader cannot collect on, and
// prose is where it hides — the import check below only reads fenced code.
test('every @pwngh specifier a package document names is one that resolves', () => {
  const installed = (name: string) =>
    existsSync(join(NODE_MODULES, name, 'package.json'));
  const seenIn = new Map<string, number>();
  for (const doc of docs) {
    for (const m of doc.text.matchAll(
      /@pwngh\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*/g,
    )) {
      const spec = m[0];
      const bare = spec.split('/').slice(0, 2).join('/');
      seenIn.set(doc.label, (seenIn.get(doc.label) ?? 0) + 1);
      assert.ok(
        installed(bare),
        `${doc.label}: names ${spec}, and ${bare} is not a package`,
      );
      if (spec === bare) continue;
      // A bare name may ship no root export by design; a subpath is a door and has to open.
      let opens = true;
      try {
        import.meta.resolve(spec);
      } catch {
        opens = false;
      }
      assert.ok(
        opens,
        `${doc.label}: names ${spec}, which ${bare} does not export`,
      );
    }
  }
  // Per document, not in total: one README naming forty specifiers satisfies a total while
  // every other README goes unread.
  const readmes = packages.filter((p) => p.readme);
  assert.equal(readmes.length, 18, `read ${readmes.length} READMEs`);
  for (const p of readmes)
    assert.ok(
      (seenIn.get(`${p.name} README`) ?? 0) > 0,
      `${p.name}: its README names no @pwngh package, not even the one it tells a reader to install`,
    );
});

/** The one package a consumer installs. The split below it is a publishing concern. */
const UMBRELLA = '@pwngh/economy';

/** The door list, and the document a reader meets it in. */
const MANIFEST = join(PACKAGES, 'economy', 'manifest.json');
const UMBRELLA_README = join(PACKAGES, 'economy', 'README.md');

/** Every key a consumer types. `_`-prefixed keys are notes to whoever edits the file. */
function doors(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<
    string,
    string
  >;
  return Object.keys(manifest).filter((key) => !key.startsWith('_'));
}

/**
 * A door the umbrella README is allowed to leave unnamed, written out with its reason. It is
 * empty, and that is the finding rather than the design: every door in the manifest is a path a
 * consumer types, so every one belongs in the document they read first.
 */
const UNDOCUMENTED_DOORS = new Map<string, string>();

// The mirror of every check above. Those ask whether what the README says is true; this one
// asks whether what is true is said. It found eight doors the README had never named.
test('every door in the manifest is named in the umbrella README', () => {
  const md = readFileSync(UMBRELLA_README, 'utf8');
  // What counts is the specifier a reader types, wherever it appears — a table row, a fenced
  // import, a sentence. The bare `economy/sqs` shorthand the prose uses does not, because a
  // reader cannot paste it. Longest match wins, so a line naming `economy/money/rate` does not
  // credit `economy/money`.
  const named = new Set(
    [...md.matchAll(/@pwngh\/economy(?:\/[a-z0-9][a-z0-9-]*)*/g)].map(
      (m) => m[0],
    ),
  );

  const missing: string[] = [];
  let examined = 0;
  let documented = 0;
  let exempted = 0;
  for (const door of doors()) {
    examined += 1;
    const reason = UNDOCUMENTED_DOORS.get(door);
    const isNamed = named.has(`@pwngh/${door}`);
    assert.ok(
      !(isNamed && reason !== undefined),
      `${door} is named in the README and exempted from naming it: ${reason}`,
    );
    if (isNamed) documented += 1;
    else if (reason !== undefined) exempted += 1;
    else missing.push(door);
  }
  assert.deepEqual(
    missing,
    [],
    `the umbrella README names ${documented} of ${examined} doors, and is silent on ${missing.join(' ')}`,
  );

  // A door that stopped being read is a door that stopped being checked, so the count is the
  // check: every door landed in exactly one bucket, and an exemption for a door the manifest no
  // longer carries is never counted and shows up here as a shortfall.
  assert.equal(examined, 24, `read ${examined} doors`);
  assert.equal(examined, doors().length);
  assert.equal(documented + exempted, examined);
  assert.equal(exempted, UNDOCUMENTED_DOORS.size);
  for (const [door, reason] of UNDOCUMENTED_DOORS)
    assert.ok(
      reason.length > 20,
      `${door} is exempted with no reason worth reading`,
    );
});

/**
 * A package is exempt from the install line only by being written here with its reason. A
 * pattern would exempt the next package to match it, which is the drift this gate watches for.
 */
const NO_INSTALL_LINE = new Map([
  [
    'create-economy',
    'a bin behind no door: `npm create @pwngh/economy` fetches and runs it',
  ],
]);

/** Every package an `npm i` line installs, flags dropped and trailing comments cut. */
function installed(md: string): string[] {
  const out: string[] = [];
  for (const fence of fences(md, 'sh')) {
    for (const line of fence.split('\n')) {
      const m = /^\s*npm i(?:nstall)?\s+(.*)$/.exec(line.replace(/#.*$/, ''));
      if (!m) continue;
      for (const word of m[1]!.trim().split(/\s+/))
        if (word && !word.startsWith('-')) out.push(word);
    }
  }
  return out;
}

// A reader types one install and imports flat doors by name, so the install line says the
// umbrella whichever package's README they landed on. Naming the package itself is the drift.
test('each README installs the umbrella, never the package it documents', () => {
  let checked = 0;
  let exempted = 0;
  for (const p of packages) {
    // An absent README is `every package ships a README`'s to report, by name. A second
    // complaint here would only say the missing file is missing an install line.
    if (!p.readme) continue;
    const named = installed(p.readme).filter((s) => s.startsWith('@pwngh/'));
    const exemption = NO_INSTALL_LINE.get(p.name);
    if (exemption) {
      assert.deepEqual(
        named,
        [],
        `${p.name}: exempt as ${exemption}, yet its README installs ${named.join(', ')}`,
      );
      exempted += 1;
      continue;
    }
    assert.deepEqual(
      named,
      [UMBRELLA],
      `${p.name}: the install line names ${named.join(', ') || 'no @pwngh package'} — every README installs ${UMBRELLA}`,
    );
    checked += 1;
  }
  // A README with no `npm i` line at all reads as an empty roster and satisfies neither branch
  // above by accident, so the split is counted: every package but the written exemption.
  assert.equal(checked, 17, `checked ${checked} install lines`);
  assert.equal(exempted, NO_INSTALL_LINE.size);
  // Against the READMEs that exist, not the packages: an absent one is the test above's to name.
  assert.equal(checked + exempted, packages.filter((p) => p.readme).length);
});

/**
 * Every value name in one import clause is an export the specifier actually has. A name is
 * skipped where the README marks it a type, never for looking like one: Money and Rate are values.
 */
function assertNamed(
  label: string,
  spec: string,
  clause: string,
  names: Set<string>,
): number {
  let checked = 0;
  for (const raw of clause.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed || /^type\s/.test(trimmed)) continue;
    const named = trimmed.split(/\s+as\s+/)[0]!.trim();
    assert.ok(
      names.has(named),
      `${label}: imports { ${named} } from ${spec}, which does not export it`,
    );
    checked += 1;
  }
  return checked;
}

test('every @pwngh import in a package document resolves and names real exports', async () => {
  const cache = new Map<string, Set<string>>();
  const exportsOf = async (spec: string): Promise<Set<string> | null> => {
    if (cache.has(spec)) return cache.get(spec)!;
    try {
      const names = new Set(Object.keys((await import(spec)) as object));
      cache.set(spec, names);
      return names;
    } catch {
      return null;
    }
  };
  let resolved = 0;
  let checked = 0;
  for (const doc of docs) {
    for (const fence of [
      ...fences(doc.text, 'ts'),
      ...fences(doc.text, 'tsx'),
    ]) {
      for (const m of fence.matchAll(
        /import\s+(type\s+)?\{([^}]+)\}\s+from\s+'(@pwngh\/[^']+)'/g,
      )) {
        const spec = m[3]!;
        const names = await exportsOf(spec);
        assert.ok(
          names !== null,
          `${doc.label}: imports from ${spec}, which does not resolve`,
        );
        resolved += 1;
        // A whole `import type` clause is erased at runtime; resolving the specifier is
        // the only check available for it.
        if (m[1]) continue;
        checked += assertNamed(doc.label, spec, m[2]!, names);
      }
    }
  }
  // The loop is the whole test. A regex that stopped matching would pass it in silence, so
  // the counts are asserted rather than left for a reader to notice were missing. Exact, not a
  // floor: a floor set at a third of reality passes a bug that drops two thirds of the tree.
  assert.deepEqual(
    [resolved, checked],
    [61, 96],
    `resolved ${resolved} imports and checked ${checked} exported names`,
  );
});

test('every `economy` command in a package document is a verb the bin dispatches', async () => {
  const { VERBS } =
    (await import('../packages/cli/dist/lib/parse-args.js')) as {
      VERBS: string[];
    };
  assert.ok(VERBS.length > 0, 'the verb roster loaded');
  let seen = 0;
  for (const doc of docs) {
    // Only code counts: shell fences, and inline spans that start with the command itself.
    // Prose may say "the economy before your parser" without naming a verb.
    const commands = [
      ...fences(doc.text, 'sh').flatMap((f) => [
        ...f.matchAll(/^\s*economy ([a-z-]+)/gm),
      ]),
      ...doc.text.matchAll(/`economy ([a-z-]+)[^`]*`/g),
    ];
    for (const m of commands) {
      const verb = m[1]!;
      seen += 1;
      assert.ok(
        VERBS.includes(verb),
        `${doc.label}: names \`economy ${verb}\`, which is not a verb (roster: ${VERBS.join(' ')})`,
      );
    }
  }
  // Both regexes above are the whole test, and either one silently ceasing to match leaves
  // every assertion satisfied by an empty loop.
  assert.equal(seen, 33, `read ${seen} economy commands`);
});

/**
 * The roots a path in a package document can be relative to. A document is written beside its
 * own package and about a tree rooted here, and it names nothing above either.
 */
const rootsFor = (pkg: Pkg): readonly string[] => [pkg.dir, ROOT];

/**
 * The one head segment that is ambiguous rather than resolvable. `economy/` is three things at
 * once in a package document: the umbrella's door namespace (`economy/auth`), the file a reader
 * writes (`economy/app.ts`), and — since this repository started running its own product — a real
 * directory here. A document written for the reader means one of the first two, so no span under
 * it is a claim about this tree, and this gate has no standing to fail one.
 */
const READER_OWNED = 'economy';

/**
 * A span is a claim about this repository only when its first segment is a directory that
 * exists at one of the roots. Everything else is a path in the reader's own project.
 */
function anchors(pkg: Pkg, span: string): readonly string[] {
  if (!span.includes('/') || /[\s()<>*?"'=@$]/.test(span)) return [];
  if (span.startsWith('.') || span.startsWith('/') || span.startsWith('-'))
    return [];
  const head = span.replace(/\/+$/, '').split('/')[0]!;
  if (head === READER_OWNED) return [];
  return rootsFor(pkg).filter((root) => isDir(join(root, head)));
}

// The check that would have caught a CHANGELOG crediting a generator script nobody wrote.
// Fences are dropped first: a fence may print the tree of a project the reader is about to
// have, and a path there is not a claim about this one.
test('every repository path a package document names is on disk', () => {
  let examined = 0;
  for (const doc of docs) {
    for (const span of spans(doc.text)) {
      const roots = anchors(doc.pkg, span);
      if (!roots.length) continue;
      examined += 1;
      const rel = span.replace(/\/+$/, '');
      assert.ok(
        roots.some((root) => existsSync(join(root, rel))),
        `${doc.label}: names ${span}, which is not at ${roots
          .map((root) => `${relative(ROOT, root) || '.'}/${rel}`)
          .join(' or ')}`,
      );
    }
  }
  // A path that anchors nowhere is skipped, so a broken anchor would empty this loop and pass
  // it in silence. The count is asserted instead.
  assert.equal(examined, 16, `read ${examined} repository paths`);
});

// Composition here is flat: pieces imported at one level, never rungs climbed or peeled.
// A README that reaches for the ladder is describing a shape these packages do not have.
test('no README climbs a ladder', () => {
  const LADDER = [
    /\brungs?\b/i,
    /\bpeels?\b/i,
    /\bpeeling\b/i,
    /\baltitude\b/i,
    /\bdescends?\b/i,
    /\bR[0-3]\b/,
  ];
  for (const p of packages) {
    for (const word of LADDER) {
      assert.equal(
        word.test(p.readme),
        false,
        `${p.name}: README says ${String(word)}`,
      );
    }
  }
});

// Presence, not position. Installation is where the umbrella claim is checked and License is
// what the tarball is bound by, so both have to be there; which one comes last does not change
// what either says, and pinning that fired on every README that grew a section.
test('each README carries the house sections', () => {
  let checked = 0;
  for (const p of packages) {
    const headings = [...p.readme.matchAll(/^## (.+)$/gm)].map((m) =>
      m[1]!.trim(),
    );
    assert.ok(p.readme.startsWith('# '), `${p.name}: opens with an h1`);
    for (const required of ['Installation', 'License']) {
      assert.ok(
        headings.includes(required),
        `${p.name}: has a "## ${required}" section`,
      );
    }
    checked += 1;
  }
  assert.equal(checked, 18, `checked ${checked} READMEs`);
});

/**
 * A document's prose, one block to a line. A claim is a sentence and Markdown wraps a sentence
 * across lines, so a reader that works a line at a time is blind to every wrapped one. Fences
 * drop out, because an example is not a claim, and a table row becomes one line per cell so a
 * sentence pattern cannot run out of one cell into the next.
 */
function prose(md: string): string {
  const lines: string[] = [];
  let wrapped: string[] = [];
  const flush = () => {
    if (wrapped.length) lines.push(wrapped.join(' '));
    wrapped = [];
  };
  for (const raw of md.replace(/```[\s\S]*?```/g, '\n\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('|')) {
      flush();
      for (const cell of line.split('|')) {
        const text = cell.trim();
        if (text) lines.push(text);
      }
      continue;
    }
    if (/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>)/.test(line)) flush();
    wrapped.push(line);
  }
  flush();
  return lines.join('\n');
}

/** What a claim is about, and how the code is asked to settle it. */
type ClaimKind = 'failure' | 'order' | 'fields';

/**
 * The sentence shapes this gate can settle. A sentence matching one of them says something the
 * code can be run to check, and the sweep below finds every one in every package README. That is
 * what keeps the subset honest: the claims resolved are every claim of a shape this file can
 * read, not whatever anyone remembered to list.
 */
const CLAIM_SHAPES: ReadonlyArray<readonly [ClaimKind, RegExp]> = [
  ['failure', /\bthrows\b[^.\n]*?`[A-Z][A-Z0-9_]*\.[A-Z0-9_]+`/],
  ['order', /\band only then\b|\bin this order\b/],
  [
    'fields',
    /\b(?:reads|requires)\b[^.\n]*?`[a-z][A-Za-z0-9]*`,\s*`[a-z][A-Za-z0-9]*`/,
  ],
];

/** Which document of a package a claim sentence lives in. */
type DocKind = 'README' | 'CHANGELOG';

/** One prose surface of one package: what a sighting sits in and a claim is located in. */
interface ClaimDoc {
  readonly slug: string;
  readonly doc: DocKind;
  readonly text: string;
}

/** One claim-shaped sentence, and where it sits in its document's prose. */
interface Sighting {
  readonly slug: string;
  readonly doc: DocKind;
  readonly kind: ClaimKind;
  readonly at: number;
  readonly text: string;
}

/** Every claim-shaped sentence in one document. */
function sightingsIn(source: ClaimDoc): Sighting[] {
  const out: Sighting[] = [];
  for (const [kind, shape] of CLAIM_SHAPES)
    for (const m of source.text.matchAll(new RegExp(shape.source, 'g')))
      out.push({
        slug: source.slug,
        doc: source.doc,
        kind,
        at: m.index!,
        text: m[0],
      });
  return out;
}

/**
 * The population the claim layer reads: every README whole, every CHANGELOG down to its undated
 * blocks. A dated block is the record of a publish and the code it described has moved since, so
 * a claim there is history rather than a promise about this tree, and no probe runs against it.
 * Only the release still being written is held to today's code.
 */
const PROSE: readonly ClaimDoc[] = packages.flatMap((p) => [
  ...(p.readme
    ? [{ slug: p.slug, doc: 'README' as const, text: prose(p.readme) }]
    : []),
  ...(p.changelog
    ? [
        {
          slug: p.slug,
          doc: 'CHANGELOG' as const,
          text: prose(undated(p.changelog)),
        },
      ]
    : []),
]);

/** What a sentence says an operation does when the thing behind it refuses. */
interface Failure {
  readonly code: string;
  readonly retryable: boolean;
}

/** The field names a sentence says a body must carry, and the ones it may. */
interface Roster {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/** Whether a body survived the decoder, keyed by the field left out of it. */
type Verdicts = Readonly<Record<string, 'accepted' | 'refused'>>;

/** The steps a sentence says run, in the order it says they run, and any count it states. */
interface Order {
  readonly steps: readonly string[];
  readonly stated: number | null;
}

/** Where a claim is written, and what to call it when it does not hold. */
interface Site {
  readonly slug: string;
  readonly doc: DocKind;
  readonly what: string;
  /** Matched against the document's prose, exactly once. Its groups are what gets parsed. */
  readonly locate: RegExp;
}

/**
 * A claim and the probe that settles it. A probe never reads the document — it runs the code and
 * reports what the code did, so the two sides of every comparison come from different places.
 */
type Claim =
  | (Site & { readonly kind: 'failure'; observe(): Promise<Failure[]> })
  | (Site & { readonly kind: 'order'; observe(): Promise<string[]> })
  | (Site & {
      readonly kind: 'fields';
      observe(claimed: Roster): Promise<Verdicts>;
    });

/** What an operation actually does, reported the way a sentence describes one. */
async function thrown(run: () => Promise<unknown>): Promise<Failure> {
  try {
    await run();
  } catch (error) {
    const raised = error as { code?: unknown; retryable?: unknown };
    return {
      code:
        typeof raised.code === 'string'
          ? raised.code
          : `an error carrying no code: ${String(error)}`,
      retryable: raised.retryable === true,
    };
  }
  return { code: 'nothing thrown', retryable: false };
}

/** A backend that is not there. Every claim below is about what happens when one is not. */
const unreachable = async (): Promise<never> => {
  throw new Error('the backend is unreachable');
};

async function redisCacheFailure(): Promise<Failure[]> {
  const { redisCache } = await import('@pwngh/economy-redis');
  const down = { get: unreachable, set: unreachable, del: unreachable };
  const cache = redisCache(down as Parameters<typeof redisCache>[0]);
  return [
    await thrown(() => cache.get('k')),
    await thrown(() => cache.set('k', 'v')),
  ];
}

async function redisLimiterFailure(): Promise<Failure[]> {
  const { redisRateLimiter } = await import('@pwngh/economy-redis');
  const down = { eval: unreachable };
  const limiter = redisRateLimiter(
    down as Parameters<typeof redisRateLimiter>[0],
    {
      limit: 5,
      windowMs: 60_000,
    },
  );
  return [await thrown(() => limiter.allow('usr_readme'))];
}

async function sqsSendFailure(): Promise<Failure[]> {
  const { sqsDispatcher } = await import('@pwngh/economy-sqs');
  const dispatch = sqsDispatcher({
    queueUrl: 'https://sqs.example.invalid/queue',
    client: { send: unreachable },
  });
  return [
    await thrown(() =>
      dispatch({
        id: 'evt_readme',
        type: 'economy.credits.topped_up',
        version: 1,
        occurredAt: 0,
        subject: 'usr_readme',
        data: { amount: 'CREDIT:1.00' },
        audience: 'internal',
      }),
    ),
  ];
}

async function corePostureFailure(): Promise<Failure[]> {
  const { createApp } = await import('@pwngh/economy-core');
  const app = await createApp({ worker: false }, { env: {} });
  try {
    return [await thrown(async () => app.handler)];
  } finally {
    await app.close();
  }
}

/** The step a refusal reason names, which is how the gate's order is read off its answers. */
const WEBHOOK_STEP: Readonly<Record<string, string>> = {
  oversize: 'bounds',
  signature: 'signature',
  stale: 'freshness',
  malformed: 'decode',
  replay: 'claim',
};

/** JSON as the bytes a provider would have sent. */
const bytes = (body: unknown) =>
  new TextEncoder().encode(JSON.stringify(body)) as Uint8Array<ArrayBuffer>;

/**
 * The order the webhook gate runs its steps in, read off the code. Each stage satisfies one more
 * step than the last and breaks every step after it, so the reason that comes back names the
 * earliest step still unsatisfied. A step that moved shows up as a different answer here.
 */
async function webhookOrder(): Promise<string[]> {
  const { createWebhookVerifier, signBody } =
    await import('@pwngh/economy-webhook');
  const secret = 'readme-gate-secret';
  const good = bytes({
    eventId: 'evt_readme',
    userId: 'usr_readme',
    source: 'readme',
    amount: 'CREDIT:120.00',
  });
  const junk = bytes({ nothing: true });
  // A store that grants nothing, so a delivery that reaches the claim says it reached it.
  const replay = { claim: async () => ({ claimed: false }) };
  const gate = createWebhookVerifier({ secrets: [secret], replay });
  const tight = createWebhookVerifier({
    secrets: [secret],
    replay,
    maxBodyBytes: 4,
  });
  const deliver = async (
    verifier: typeof gate,
    input: {
      raw: Uint8Array<ArrayBuffer>;
      signature: string;
      timestamp: number;
    },
  ): Promise<string> => {
    const result = await verifier.verifyDelivery({ provider: 'p', ...input });
    const reason = 'reason' in result ? result.reason : '';
    const step = WEBHOOK_STEP[reason];
    assert.ok(
      step,
      `the webhook gate answered ${reason || 'with no reason'}, which names no step`,
    );
    return step;
  };
  const stale = {
    raw: junk,
    signature: await signBody(junk, secret),
    timestamp: 0,
  };
  return [
    await deliver(tight, { ...stale, signature: 'sha256=00' }),
    await deliver(gate, { ...stale, signature: 'sha256=00' }),
    await deliver(gate, stale),
    await deliver(gate, { ...stale, timestamp: Date.now() }),
    await deliver(gate, {
      raw: good,
      signature: await signBody(good, secret),
      timestamp: Date.now(),
    }),
  ];
}

/** A value the default decoder will accept for each field a README can name. */
const SAMPLE_FIELDS: Readonly<Record<string, string>> = {
  eventId: 'evt_readme',
  userId: 'usr_readme',
  source: 'readme',
  amount: 'CREDIT:120.00',
  sku: 'sku_readme',
};

/**
 * What the default decoder does with the roster a README states: the whole roster, then the
 * roster with one name left out, once per name. A field the README forgot makes the whole roster
 * refuse; a field it invented is one whose absence changes nothing.
 */
async function webhookFields(claimed: Roster): Promise<Verdicts> {
  const { createWebhookVerifier, signBody } =
    await import('@pwngh/economy-webhook');
  const secret = 'readme-gate-secret';
  const gate = createWebhookVerifier({ secrets: [secret] });
  const verdicts: Record<string, 'accepted' | 'refused'> = {};
  for (const omitted of ['', ...claimed.required, ...claimed.optional]) {
    const body: Record<string, string> = {};
    for (const field of [...claimed.required, ...claimed.optional]) {
      assert.ok(
        field in SAMPLE_FIELDS,
        `the webhook roster names \`${field}\`, and this gate has no sample value to send for it`,
      );
      if (field !== omitted) body[field] = SAMPLE_FIELDS[field]!;
    }
    const raw = bytes(body);
    const result = await gate.verifyDelivery({
      provider: 'p',
      raw,
      signature: await signBody(raw, secret),
      timestamp: Date.now(),
    });
    verdicts[omitted] = result.status === 'verified' ? 'accepted' : 'refused';
  }
  return verdicts;
}

/** A rate body `Rate.from` accepts whole, one value per field name a document can state. */
const SAMPLE_RATE: Readonly<Record<string, unknown>> = {
  rate: '5',
  scale: 3,
  rateId: 'payout:CREDIT->USD:5/3',
};

/**
 * What `Rate.from` does with the roster the CHANGELOG states: the whole roster, then the roster
 * with one name left out, once per name — the same drive `webhookFields` gives the decoder.
 * Refused means the call threw; which error a refusal carries is prose outside the roster shape.
 */
async function rateFields(claimed: Roster): Promise<Verdicts> {
  const { Rate } = await import('@pwngh/economy-money');
  const verdicts: Record<string, 'accepted' | 'refused'> = {};
  for (const omitted of ['', ...claimed.required, ...claimed.optional]) {
    const init: Record<string, unknown> = {};
    for (const field of [...claimed.required, ...claimed.optional]) {
      assert.ok(
        field in SAMPLE_RATE,
        `the rate roster names \`${field}\`, and this gate has no sample value to send for it`,
      );
      if (field !== omitted) init[field] = SAMPLE_RATE[field];
    }
    let verdict: 'accepted' | 'refused' = 'accepted';
    try {
      // Deliberately shy of the type: the probe sends what the page said a body must carry.
      Rate.from(init as never);
    } catch {
      verdict = 'refused';
    }
    verdicts[omitted] = verdict;
  }
  return verdicts;
}

/**
 * Every claim resolved here, each written where its sentence is. A `locate` never carries the
 * answer — it says which sentence is the claim, and the probe beside it says what the code does.
 */
const CLAIMS: readonly Claim[] = [
  {
    kind: 'order',
    slug: 'webhook',
    doc: 'README',
    what: 'the order the opening sentence promises',
    locate: /`webhook` (?<order>reads [^\n]*?)\./,
    observe: webhookOrder,
  },
  {
    kind: 'order',
    slug: 'webhook',
    doc: 'README',
    what: 'the numbered order under "The order"',
    locate:
      /runs (?<count>[a-z]+) steps, in this order[^\n]*\n(?<order>(?:\d+\.[^\n]*\n){2,})/,
    observe: webhookOrder,
  },
  {
    kind: 'fields',
    slug: 'webhook',
    doc: 'README',
    what: 'the roster the default decoder demands',
    locate: /The default decoder (?<claim>reads[^.\n]*)\./,
    observe: webhookFields,
  },
  {
    kind: 'fields',
    slug: 'money',
    doc: 'CHANGELOG',
    what: 'the roster `Rate.from` demands',
    locate: /`RateInit` (?<claim>requires[^;.\n]*)/,
    observe: rateFields,
  },
  {
    kind: 'failure',
    slug: 'redis',
    doc: 'README',
    what: 'what a failed cache read or write does',
    locate: /a failed read or write (?<claim>throws[^,\n]*`[^`]+`)/,
    observe: redisCacheFailure,
  },
  {
    kind: 'failure',
    slug: 'redis',
    doc: 'README',
    what: 'what a limiter that cannot reach Redis does',
    locate: /A limiter that cannot reach Redis (?<claim>throws[^,\n]*`[^`]+`)/,
    observe: redisLimiterFailure,
  },
  {
    kind: 'failure',
    slug: 'sqs',
    doc: 'README',
    what: 'what a rejected send does',
    locate: /a rejected send (?<claim>throws[^,\n]*`[^`]+`[^,\n]*)/,
    observe: sqsSendFailure,
  },
  {
    kind: 'failure',
    slug: 'core',
    doc: 'README',
    what: 'what reading the handler with no posture does',
    locate: /`authenticate` posture (?<claim>throws `[^`]+`)/,
    observe: corePostureFailure,
  },
];

/** The one sentence a claim is written in. Two of them, or none, is a claim nobody can read. */
function locate(claim: Claim): RegExpMatchArray {
  const source = PROSE.find(
    (d) => d.slug === claim.slug && d.doc === claim.doc,
  );
  assert.ok(
    source,
    `packages/${claim.slug}/${claim.doc}.md: no document to read`,
  );
  const found = [...source.text.matchAll(new RegExp(claim.locate.source, 'g'))];
  assert.equal(
    found.length,
    1,
    `packages/${claim.slug}/${claim.doc}.md: ${claim.what} is stated ${found.length} times, and this gate reads exactly one`,
  );
  return found[0]!;
}

function parseFailure(claim: Claim, m: RegExpMatchArray): Failure {
  const said = m.groups?.claim ?? '';
  const code = /`([A-Z][A-Z0-9_]*\.[A-Z0-9_]+)`/.exec(said);
  assert.ok(
    code,
    `${claim.slug} ${claim.doc}: ${claim.what} names no error code`,
  );
  return { code: code[1]!, retryable: /\bretryable\b/.test(said) };
}

/** The steps this gate knows by name, and the words a sentence names each of them with. */
const STEP_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ['bounds', /byte ceiling|bounded body/],
  ['signature', /signature/],
  ['freshness', /freshness window/],
  ['decode', /\bdecoder\b|decodes the body/],
  ['claim', /replay claim|claims the provider's event id/],
];

/** Spelled counts, so a sentence that says how many steps it lists is checked on that too. */
const COUNT_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseOrder(claim: Claim, m: RegExpMatchArray): Order {
  const said = m.groups?.order ?? '';
  // A numbered list arrives one step to a line; a sentence arrives as one line of clauses.
  const clauses = (said.includes('\n') ? said.split('\n') : said.split(','))
    .map((clause) => clause.trim())
    .filter(Boolean);
  const steps = clauses.map((clause) => {
    const named = STEP_WORDS.filter(([, words]) => words.test(clause)).map(
      ([step]) => step,
    );
    assert.equal(
      named.length,
      1,
      `${claim.slug} ${claim.doc}: "${clause}" names ${named.length} steps this gate knows, and an order it cannot read is an order it cannot check`,
    );
    return named[0]!;
  });
  assert.equal(
    new Set(steps).size,
    steps.length,
    `${claim.slug} ${claim.doc}: ${claim.what} names a step twice`,
  );
  const word = m.groups?.count;
  if (word === undefined) return { steps, stated: null };
  const stated = COUNT_WORDS[word];
  assert.ok(
    stated,
    `${claim.slug} ${claim.doc}: ${claim.what} says "${word}" steps, which is not a number this gate spells`,
  );
  return { steps, stated };
}

function parseFields(claim: Claim, m: RegExpMatchArray): Roster {
  const said = m.groups?.claim ?? '';
  const names = (part: string) =>
    [...part.matchAll(/`([a-z][A-Za-z0-9]*)`/g)].map((hit) => hit[1]!);
  const [demanded, offered] = said.split(/\b(?:and )?an? optional\b/);
  const roster = {
    required: names(demanded ?? ''),
    optional: names(offered ?? ''),
  };
  assert.ok(
    roster.required.length > 0,
    `${claim.slug} ${claim.doc}: ${claim.what} names no required field`,
  );
  return roster;
}

function compareFailure(
  claim: Claim,
  claimed: Failure,
  observed: readonly Failure[],
): void {
  assert.ok(
    observed.length > 0,
    `${claim.slug} ${claim.doc}: ${claim.what} was compared against nothing run`,
  );
  for (const seen of observed)
    assert.deepEqual(
      seen,
      claimed,
      `${claim.slug} ${claim.doc}: ${claim.what} — the page says ${JSON.stringify(claimed)}, the code does ${JSON.stringify(seen)}`,
    );
}

function compareOrder(
  claim: Claim,
  claimed: Order,
  observed: readonly string[],
): void {
  assert.ok(
    observed.length > 0,
    `${claim.slug} ${claim.doc}: ${claim.what} was compared against nothing run`,
  );
  assert.deepEqual(
    claimed.steps,
    observed,
    `${claim.slug} ${claim.doc}: ${claim.what} — the page says ${claimed.steps.join(' → ')}, the code runs ${observed.join(' → ')}`,
  );
  if (claimed.stated !== null)
    assert.equal(
      claimed.stated,
      observed.length,
      `${claim.slug} ${claim.doc}: ${claim.what} says ${claimed.stated} steps, and the code runs ${observed.length}`,
    );
}

function compareFields(
  claim: Claim,
  claimed: Roster,
  observed: Verdicts,
): void {
  // The whole roster is taken, every required name is missed when it is gone, and every optional
  // one is not. A README short a field fails the first; one that invented a field fails the rest.
  const expected: Record<string, 'accepted' | 'refused'> = { '': 'accepted' };
  for (const field of claimed.required) expected[field] = 'refused';
  for (const field of claimed.optional) expected[field] = 'accepted';
  assert.deepEqual(
    observed,
    expected,
    `${claim.slug} ${claim.doc}: ${claim.what} — keyed by the field left out, the page promises ${JSON.stringify(expected)} and the decoder gives ${JSON.stringify(observed)}`,
  );
}

/** Runs one claim end to end, and hands back what the code did so a control can reuse it. */
async function resolveClaim(claim: Claim): Promise<void> {
  const m = locate(claim);
  switch (claim.kind) {
    case 'failure':
      return compareFailure(
        claim,
        parseFailure(claim, m),
        await claim.observe(),
      );
    case 'order':
      return compareOrder(claim, parseOrder(claim, m), await claim.observe());
    case 'fields': {
      const claimed = parseFields(claim, m);
      return compareFields(claim, claimed, await claim.observe(claimed));
    }
  }
}

// The collector, checked before anything it collects. A regex that stopped matching, or a
// normaliser that stopped joining a wrapped sentence, would leave every check below satisfied by
// an empty population — which is the failure this gate is replacing.
test('the claim sweep sees a claim, and sees it wrapped, tabled or fenced', () => {
  const md = [
    '# fixture',
    '',
    'A read that fails',
    'throws `STORE.FAILURE`, in a sentence Markdown wrapped.',
    '',
    '```ts',
    'throws `FENCED.CODE`;',
    '```',
    '',
    '| `a`, `b` | reads `c`, `d` |',
    '',
    'The gate runs two steps, in this order:',
    '',
    'It decodes the body, and only then claims the provider event id.',
  ].join('\n');
  const text = prose(md);
  assert.match(
    text,
    /A read that fails throws `STORE\.FAILURE`/,
    'a wrapped sentence is read as one sentence',
  );
  assert.doesNotMatch(text, /FENCED\.CODE/, 'a fence is not prose');
  assert.match(
    text,
    /`a`, `b`\nreads `c`, `d`/,
    'a table row is one line a cell',
  );
  const kinds = sightingsIn({ slug: 'fixture', doc: 'README', text }).map(
    (s) => s.kind,
  );
  assert.deepEqual(
    kinds.sort(),
    ['failure', 'fields', 'order', 'order'],
    `the sweep found ${kinds.join(' ')}`,
  );
});

// The boundary a CHANGELOG adds to the claim surface, proven on a fixture before it is trusted
// on the tree: one sentence is a claim while its block is still being written, and history once
// the block is dated. This gate fails false claims about this tree, and a dated block is a true
// record of another one.
test('a CHANGELOG claim is swept until its block is dated, and never after', () => {
  const claim = 'It requires `alpha`, `beta`, and `gamma` in every body.';
  const changelog = (heading: string) =>
    ['# fixture', '', `## ${heading}`, '', `- ${claim}`].join('\n');
  const swept = (heading: string) =>
    sightingsIn({
      slug: 'fixture',
      doc: 'CHANGELOG',
      text: prose(undated(changelog(heading))),
    });
  assert.equal(swept('Unreleased').length, 1, 'an undated block is swept');
  assert.equal(swept('0.1.0 - 2026-07-25').length, 0, 'a dated block is not');
});

// The population, proven against the documents on disk rather than against a list here. A claim
// of a shape this gate can settle is not allowed to go unregistered: that is the difference
// between a stated subset and an accidental one.
test('every claim-shaped sentence in every package document is registered', () => {
  assert.equal(PROSE.length, 36, `swept ${PROSE.length} documents`);
  assert.equal(
    PROSE.length,
    packages.filter((p) => p.readme).length +
      packages.filter((p) => p.changelog).length,
    'the sweep read every README and CHANGELOG on disk',
  );
  const found = PROSE.flatMap((source) => sightingsIn(source));
  const tally = (kind: ClaimKind) =>
    found.filter((s) => s.kind === kind).length;
  assert.deepEqual(
    [tally('failure'), tally('order'), tally('fields')],
    [4, 2, 2],
    `swept ${found.length} claim-shaped sentences`,
  );
  const spans = CLAIMS.map((claim) => {
    const m = locate(claim);
    return { claim, from: m.index!, to: m.index! + m[0].length };
  });
  for (const sighting of found) {
    const covering = spans.filter(
      ({ claim, from, to }) =>
        claim.slug === sighting.slug &&
        claim.doc === sighting.doc &&
        sighting.at >= from &&
        sighting.at < to,
    );
    assert.equal(
      covering.length,
      1,
      `packages/${sighting.slug}/${sighting.doc}.md: "${sighting.text}" is a claim this gate could settle and ${covering.length} registered claims cover it`,
    );
  }
  for (const { claim, from, to } of spans) {
    const covered = found.filter(
      (s) =>
        s.slug === claim.slug &&
        s.doc === claim.doc &&
        s.at >= from &&
        s.at < to,
    );
    assert.equal(
      covered.length,
      1,
      `${claim.slug} ${claim.doc}: ${claim.what} is registered and covers ${covered.length} swept sentences`,
    );
  }
  assert.equal(CLAIMS.length, found.length);
});

test('every registered claim holds against the code it describes', async () => {
  let resolved = 0;
  for (const claim of CLAIMS) {
    await resolveClaim(claim);
    resolved += 1;
  }
  // The loop is the test. Eight claims are what this file can settle, and a claim that quietly
  // stopped being reached would leave it green.
  assert.equal(resolved, 8, `resolved ${resolved} claims`);
});

// Every check above is satisfied by a gate that fails everything, and every one of them is
// satisfied by a gate that fails nothing. Both halves are pinned here against the same probes the
// checks use, so a comparison that lost its teeth fails here rather than passing the tree.
test('a claim comparison passes a true claim and fails each way of getting it wrong', async () => {
  const failure = CLAIMS.find(
    (c) => c.kind === 'failure' && c.slug === 'redis',
  )!;
  const seen = await (failure as Extract<Claim, { kind: 'failure' }>).observe();
  const said = parseFailure(failure, locate(failure));
  compareFailure(failure, said, seen);
  assert.throws(
    () =>
      compareFailure(failure, { ...said, retryable: !said.retryable }, seen),
    /README/,
    'a page that got retryable backwards passes',
  );
  assert.throws(
    () => compareFailure(failure, { ...said, code: 'STORE.MISSING' }, seen),
    /README/,
    'a page that named another error passes',
  );
  assert.throws(
    () => compareFailure(failure, said, []),
    /README/,
    'a probe that ran nothing passes',
  );

  const order = CLAIMS.find((c) => c.kind === 'order')!;
  const steps = await (order as Extract<Claim, { kind: 'order' }>).observe();
  compareOrder(order, { steps, stated: steps.length }, steps);
  assert.throws(
    () =>
      compareOrder(
        order,
        { steps: [...steps].reverse(), stated: steps.length },
        steps,
      ),
    /README/,
    'a page that ran the order backwards passes',
  );
  assert.throws(
    () => compareOrder(order, { steps, stated: steps.length - 1 }, steps),
    /README/,
    'a page that miscounted its own steps passes',
  );

  // Both README defects this gate was built for, replayed against the live decoder: the roster
  // that forgot `source`, and the roster that called an optional field required.
  const fields = CLAIMS.find((c) => c.kind === 'fields' && c.doc === 'README')!;
  const probe = (fields as Extract<Claim, { kind: 'fields' }>).observe;
  const roster = parseFields(fields, locate(fields));
  compareFields(fields, roster, await probe(roster));
  const short: Roster = {
    required: roster.required.filter((f) => f !== 'source'),
    optional: roster.optional,
  };
  assert.notDeepEqual(
    short.required,
    roster.required,
    'the roster names source',
  );
  await assert.rejects(
    async () => compareFields(fields, short, await probe(short)),
    /README/,
    'a roster missing a field the decoder demands passes',
  );
  const overstated: Roster = {
    required: [...roster.required, ...roster.optional],
    optional: [],
  };
  assert.ok(roster.optional.length > 0, 'the roster names an optional field');
  await assert.rejects(
    async () => compareFields(fields, overstated, await probe(overstated)),
    /README/,
    'a roster calling an optional field required passes',
  );

  // The CHANGELOG claim, held to both halves of the same standard: its true roster passes
  // against the live `Rate.from`, and a roster short one required name fails, in a message
  // naming the CHANGELOG rather than a README.
  const rate = CLAIMS.find((c) => c.doc === 'CHANGELOG')!;
  const rateProbe = (rate as Extract<Claim, { kind: 'fields' }>).observe;
  const rateRoster = parseFields(rate, locate(rate));
  compareFields(rate, rateRoster, await rateProbe(rateRoster));
  const rateShort: Roster = {
    required: rateRoster.required.filter((f) => f !== 'rateId'),
    optional: rateRoster.optional,
  };
  assert.notDeepEqual(
    rateShort.required,
    rateRoster.required,
    'the roster names rateId',
  );
  await assert.rejects(
    async () => compareFields(rate, rateShort, await rateProbe(rateShort)),
    /CHANGELOG/,
    'a roster missing a field Rate.from demands passes',
  );
});
