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
 * Finds the places a package re-implements what the lab already computes.
 *
 * Three channels with disjoint blind spots, because no single one sees the forks in this tree.
 * Hashing a normalised token stream — the obvious instrument — was measured against the eight
 * known forks and matched none of them: the copies agree on every output while sharing almost no
 * text. Same-name matching found all eight. A rename defeats same-name matching, so near-match
 * scoring exists for that case, and two copies of a regex share no function at all, so duplicated
 * values are read separately.
 *
 * THE WALK COVERS FOUR TREES AND THE THREE CHANNELS DO NOT ALL READ ALL OF THEM. `sourceFiles`
 * reads `src/`, `test/`, `scripts/` and their per-package equivalents, tagging each unit
 * `shipped` or `rig`; which channel gets which tag is decided in `test/dedupe.test.ts`, with the
 * measurement behind it. Nothing here filters — a caller that hands a channel every unit gets an
 * answer over every unit. Near-match is the one channel that scores the two trees differently:
 * a shipped pair is compared with literals collapsed, a rig-involved pair with literals kept,
 * because literal erasure inverts between the two populations. The measurements are on the two
 * thresholds below.
 *
 * WHAT NO CHANNEL SEES, at any scope: a rule smaller than a function body. All three compare
 * declarations, so a one-line invariant the lab states as an inline expression and a package
 * restates as its own expression matches none of them. Both forks this tree grew in the week to
 * 2026-07-30 were that shape. `LAB_OWNED_RULES` in the gate holds each one's single statement and
 * the consumers that import it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

type Ts = typeof import('typescript');
type Node = import('typescript').Node;
type SourceFile = import('typescript').SourceFile;

/**
 * The root compiler, by absolute path, for every file regardless of which TypeScript its package
 * pins.
 *
 * Typechecking resolves the compiler each package declares; this does the opposite deliberately,
 * because comparing two files parsed by two parsers compares the parsers. Only `createSourceFile`
 * is used — a syntactic parse with no program and no `tsconfig` — so a difference between two
 * majors cannot reach it. A bare `import 'typescript'` resolves against the cwd.
 */
export async function openCompiler(root: string): Promise<Ts> {
  const entry = join(root, 'node_modules/typescript/lib/typescript.js');
  if (!existsSync(entry)) {
    throw new Error(`no compiler at ${entry}`);
  }
  return (await import(pathToFileURL(entry).href)) as Ts;
}

/** Which tree a file belongs to: the lab, or the package slug under `packages/`. */
export type Scope = 'lab' | string;

/**
 * Whether a file is library source or a rig.
 *
 * A rig is anything under `test/` or `scripts/`, at the root or inside a package. The distinction
 * exists because the three channels do not transfer equally: see the scope block in
 * `test/dedupe.test.ts` for which one reads which, and the counts behind that decision.
 */
export type Tree = 'shipped' | 'rig';

export interface Unit {
  /** Repository-relative path. */
  readonly file: string;
  /** The declared name. Anonymous units are not extracted — a fork has a name. */
  readonly name: string;
  /** 1-based line of the declaration. */
  readonly line: number;
  readonly scope: Scope;
  readonly tree: Tree;
  /** True when the declaration sits at module level, or is a member of a module-level class. */
  readonly topLevel: boolean;
  /** The body, type-stripped and alpha-renamed, every literal collapsed to `S` or `0`. */
  readonly tokens: readonly string[];
  /**
   * The same stream with each literal kept as `S:<text>` or `0:<text>` — one token either way,
   * so the two streams are always the same length and every length rule reads either one.
   */
  readonly kept: readonly string[];
}

export interface ValueUnit {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly scope: Scope;
  readonly tree: Tree;
  /** The initializer's source text, whitespace-collapsed. */
  readonly text: string;
}

export interface Walk {
  readonly files: readonly string[];
  readonly units: readonly Unit[];
  readonly values: readonly ValueUnit[];
  /** Always zero. A file the parser chokes on is an unexamined file, so it stops the walk. */
  readonly parseFailures: number;
}

/**
 * The umbrella's `src/` is generated wholesale by `scripts/generate-economy.mjs`. It holds no
 * function bodies to fork.
 */
export const GENERATED_PACKAGE = 'economy';

const walkDir = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => {
          const path = join(dir, entry.name);
          return entry.isDirectory()
            ? walkDir(path)
            : /\.tsx?$/.test(entry.name)
              ? [path]
              : [];
        })
        .sort()
    : [];

/** The rig directories every scope carries, beside its `src`. */
const RIG_DIRS = ['test', 'scripts'];

/**
 * Every TypeScript file the sweep covers, lab first then packages in directory order.
 *
 * FOUR TREES, NOT TWO. `src/` and `packages/<pkg>/src` are the shipped halves; `test/`, `scripts/`,
 * `packages/<pkg>/test` and `packages/<pkg>/scripts` are rigs. Until 2026-07-30 the walk read the
 * shipped halves alone, which meant the gate CONTINUE calls "the law is gated" could not see the
 * copy that made the law visible — `Q29`'s hand-rolled Node bridge lived its whole life in
 * `packages/client/test/`, and `Q53` S6 moved eighteen units between two trees neither of which
 * was read.
 *
 * A rig takes its owner's scope rather than one of its own. The law is "a package never
 * re-implements what the lab already computes", and keeping `packages/ui/test` in the `ui` scope
 * is what makes a rig's copy of a LAB body cross a boundary while a rig's copy of its own
 * package's body stays inside one — the same shape the shipped halves already have.
 */
export function sourceFiles(
  root: string,
): { path: string; scope: Scope; tree: Tree }[] {
  const found: { path: string; scope: Scope; tree: Tree }[] = [];
  for (const path of walkDir(join(root, 'src'))) {
    found.push({ path, scope: 'lab', tree: 'shipped' });
  }
  for (const dir of RIG_DIRS) {
    for (const path of walkDir(join(root, dir))) {
      found.push({ path, scope: 'lab', tree: 'rig' });
    }
  }
  const packages = join(root, 'packages');
  if (existsSync(packages)) {
    for (const slug of readdirSync(packages, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      if (slug.name !== GENERATED_PACKAGE) {
        for (const path of walkDir(join(packages, slug.name, 'src'))) {
          found.push({ path, scope: slug.name, tree: 'shipped' });
        }
      }
      for (const dir of RIG_DIRS) {
        for (const path of walkDir(join(packages, slug.name, dir))) {
          found.push({ path, scope: slug.name, tree: 'rig' });
        }
      }
    }
  }
  return found;
}

/** Declarations that carry a body worth comparing. */
function isFunctionLike(ts: Ts, node: Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

/**
 * The name a function-like node is known by.
 *
 * An arrow assigned to a `const` takes the `const`'s name, and one assigned to an object property
 * takes the property's — both spellings are how this tree declares most of its functions.
 */
function nameOf(ts: Ts, node: Node): string | undefined {
  const named = node as { name?: import('typescript').Node };
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  const parent = node.parent;
  if (!parent) return undefined;
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  return undefined;
}

/** Module level, or a member of a class declared at module level. */
function isTopLevel(ts: Ts, node: Node): boolean {
  let cursor: Node | undefined = node;
  while (cursor?.parent) {
    const parent: Node = cursor.parent;
    if (ts.isSourceFile(parent)) return true;
    if (
      ts.isVariableDeclaration(parent) ||
      ts.isVariableDeclarationList(parent) ||
      ts.isVariableStatement(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isExportAssignment(parent)
    ) {
      cursor = parent;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Every name a unit declares itself, mapped to a placeholder.
 *
 * Renaming these is what lets a copy be recognised through its author's choice of identifiers.
 * `endOwnedPool` was byte-identical between the two engines apart from the driver type, and
 * `faulted` differed from the lab's `faultResponse` only in a parameter name.
 *
 * Parameters are numbered, because arity and order are real signal. Locals all collapse to one
 * placeholder, and that is not a shortcut — numbering them was measured and it renumbers every
 * later local when one is inserted, which shifts the loop variable and breaks every gram in the
 * body. A copy of `distinctAccounts` with a counter added scored **0.458** under numbered locals
 * and **0.769** under these; the same copy with a guard clause added instead scored 0.901 and
 * 0.897, because that insertion declares nothing. "Copy it and add a counter" is what a fork
 * looks like, so a detector with a cliff exactly there is not a detector.
 */
function declaredNames(ts: Ts, node: Node): Map<string, string> {
  const rename = new Map<string, string>();
  let parameters = 0;

  const bind = (name: Node, placeholder: string): void => {
    if (ts.isIdentifier(name)) {
      if (!rename.has(name.text)) rename.set(name.text, placeholder);
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) bind(element.name, '$v');
      }
    }
  };

  for (const parameter of (node as import('typescript').SignatureDeclaration)
    .parameters ?? []) {
    bind(parameter.name, `$p${parameters++}`);
  }

  const body = (node as { body?: Node }).body;
  if (body) {
    const collect = (child: Node): void => {
      if (ts.isVariableDeclaration(child)) bind(child.name, '$v');
      if (
        (ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child)) &&
        child.name
      ) {
        bind(child.name, '$v');
      }
      ts.forEachChild(child, collect);
    };
    ts.forEachChild(body, collect);
  }
  return rename;
}

/**
 * The body as two token streams: structure by syntax kind, identifiers alpha-renamed, literals
 * collapsed in one stream and kept in the other.
 *
 * Type annotations are dropped and, in `tokens`, strings collapse to one token because both were
 * measured to decide the answer on real pairs. With annotations in the stream the two engines'
 * `endOwnedPool` scores below any threshold on `PgPool` against `MysqlPool` alone; with string
 * literals kept it scores below it on the error prefix alone. In a rig that same erasure inverts —
 * a fixture builder is mostly literals, so two builders sharing only a shape score 1.000 — which
 * is why `kept` exists: the rig half of the near-match channel is scored on it. The `:` in the
 * kept markers is a character no identifier can contain, so a literal's text can never collide
 * with an identifier token.
 */
/** The node kinds that read as one string literal in the stream. */
function isStringy(ts: Ts, child: Node): boolean {
  return (
    ts.isStringLiteral(child) ||
    ts.isNoSubstitutionTemplateLiteral(child) ||
    child.kind === ts.SyntaxKind.TemplateHead ||
    child.kind === ts.SyntaxKind.TemplateMiddle ||
    child.kind === ts.SyntaxKind.TemplateTail
  );
}

function tokenize(ts: Ts, node: Node): { tokens: string[]; kept: string[] } {
  const rename = declaredNames(ts, node);
  const tokens: string[] = [];
  const kept: string[] = [];

  const visit = (child: Node): void => {
    if (ts.isTypeNode(child) || ts.isTypeParameterDeclaration(child)) return;
    if (ts.isIdentifier(child) || ts.isPrivateIdentifier(child)) {
      const name = rename.get(child.text) ?? child.text;
      tokens.push(name);
      kept.push(name);
      return;
    }
    if (isStringy(ts, child)) {
      tokens.push('S');
      kept.push(`S:${(child as { text?: string }).text ?? ''}`);
      return;
    }
    if (ts.isNumericLiteral(child) || ts.isBigIntLiteral(child)) {
      tokens.push('0');
      kept.push(`0:${(child as { text?: string }).text ?? ''}`);
      return;
    }
    const kind = ts.SyntaxKind[child.kind] ?? String(child.kind);
    tokens.push(kind);
    kept.push(kind);
    ts.forEachChild(child, visit);
  };

  const body = (node as { body?: Node }).body;
  if (body) visit(body);
  return { tokens, kept };
}

/** A value literal worth comparing across files, with `as const` and parentheses unwrapped. */
function literalOf(ts: Ts, node: Node | undefined): Node | undefined {
  let cursor = node;
  while (
    cursor &&
    (ts.isAsExpression(cursor) ||
      ts.isParenthesizedExpression(cursor) ||
      ts.isSatisfiesExpression(cursor))
  ) {
    cursor = cursor.expression;
  }
  if (!cursor) return undefined;
  return ts.isObjectLiteralExpression(cursor) ||
    ts.isArrayLiteralExpression(cursor) ||
    ts.isRegularExpressionLiteral(cursor) ||
    ts.isStringLiteral(cursor) ||
    ts.isNoSubstitutionTemplateLiteral(cursor) ||
    ts.isNumericLiteral(cursor)
    ? cursor
    : undefined;
}

/** The nearest named declaration around a node, for reporting an inline literal by its site. */
function enclosingName(ts: Ts, node: Node): string | undefined {
  let cursor: Node | undefined = node.parent;
  while (cursor) {
    if (
      (ts.isVariableDeclaration(cursor) ||
        ts.isFunctionDeclaration(cursor) ||
        ts.isMethodDeclaration(cursor) ||
        ts.isPropertyAssignment(cursor)) &&
      cursor.name &&
      ts.isIdentifier(cursor.name)
    ) {
      return cursor.name.text;
    }
    cursor = cursor.parent;
  }
  return undefined;
}

/**
 * Value text short enough to collide by coincidence.
 *
 * `= 0` and `= true` appear everywhere and mean nothing. Twelve characters is the shortest of the
 * duplicated values that turned out to be real.
 */
export const VALUE_FLOOR = 12;

/**
 * Every function body and every literal value in the four trees `sourceFiles` walks.
 *
 * A parse failure throws rather than skipping the file: a file nothing could read is a file
 * nothing checked, and reporting it as clean is the failure mode this tree has recorded six times.
 */
export async function walkSources(root: string): Promise<Walk> {
  const ts = await openCompiler(root);
  const files: string[] = [];
  const units: Unit[] = [];
  const values: ValueUnit[] = [];

  for (const { path, scope, tree } of sourceFiles(root)) {
    const rel = relative(root, path);
    const text = readFileSync(path, 'utf8');
    const source: SourceFile = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const broken = (
      source as unknown as { parseDiagnostics?: readonly unknown[] }
    ).parseDiagnostics;
    if (broken && broken.length > 0) {
      throw new Error(`${rel} did not parse: ${broken.length} diagnostics`);
    }
    files.push(rel);

    const lineOf = (node: Node): number =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const visit = (node: Node): void => {
      if (isFunctionLike(ts, node)) {
        const name = nameOf(ts, node);
        if (name !== undefined) {
          units.push({
            file: rel,
            name,
            line: lineOf(node),
            scope,
            tree,
            topLevel: isTopLevel(ts, node),
            ...tokenize(ts, node),
          });
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const literal = literalOf(ts, node.initializer);
        if (literal && !ts.isRegularExpressionLiteral(literal)) {
          const body = literal.getText(source).replace(/\s+/g, ' ').trim();
          if (body.length >= VALUE_FLOOR) {
            values.push({
              file: rel,
              name: node.name.text,
              line: lineOf(node),
              scope,
              tree,
              text: body,
            });
          }
        }
      }
      // A regex is read wherever it is written, not only where it is named. The SQL identifier
      // guard is a `const` in the lab and an inline `.test()` in the postgres engine, so a
      // declaration-only reader sees one of the two copies and calls the pair unique.
      if (ts.isRegularExpressionLiteral(node)) {
        const body = node.getText(source);
        if (body.length >= VALUE_FLOOR) {
          values.push({
            file: rel,
            name: enclosingName(ts, node) ?? body,
            line: lineOf(node),
            scope,
            tree,
            text: body,
          });
        }
      }
      if (ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type)) {
        const body = node.type.getText(source).replace(/\s+/g, ' ').trim();
        if (body.length >= VALUE_FLOOR) {
          values.push({
            file: rel,
            name: node.name.text,
            line: lineOf(node),
            scope,
            tree,
            text: body,
          });
        }
      }
      if (ts.isEnumDeclaration(node)) {
        const body = node.getText(source).replace(/\s+/g, ' ').trim();
        values.push({
          file: rel,
          name: node.name.text,
          line: lineOf(node),
          scope,
          tree,
          text: body,
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }

  return { files, units, values, parseFailures: 0 };
}

/** `packages/core/src/routes.ts#faulted` — how a unit is named in the allowlist. */
export const keyOf = (unit: Pick<Unit, 'file' | 'name'>): string =>
  `${unit.file}#${unit.name}`;

/**
 * The three `Store` implementations, plus the SQL kit the two engines share.
 *
 * They repeat each other's names by construction — one port written three times over three
 * drivers — so a name shared only among them is the store layer's shape, not a fork. Hard rule 2
 * of the plan: report the family, never mix it into the package-versus-lab result. Left together
 * it is four fifths of the output and it teaches a reader to skim past the part that matters.
 * Which is *not* to say the family is clean: `rowToAccrual`, `rowToSale` and `endOwnedPool` are
 * real duplication inside it, and they are moved rather than allowlisted.
 */
export const STORE_LAYER = [
  'packages/mysql/src/',
  'packages/postgres/src/',
  'src/adapters/memory.ts',
  'src/engines/',
];

/** Which trees a group of declarations spans. */
export type Family = 'STORE-LAYER' | 'PKG<->LAB' | 'PKG<->PKG' | 'LAB-ONLY';

export function familyOf(
  members: readonly { file: string; scope: Scope }[],
): Family {
  if (members.every((m) => STORE_LAYER.some((dir) => m.file.startsWith(dir)))) {
    return 'STORE-LAYER';
  }
  const scopes = new Set(members.map((m) => m.scope));
  if (!scopes.has('lab')) return 'PKG<->PKG';
  return scopes.size > 1 ? 'PKG<->LAB' : 'LAB-ONLY';
}

export interface NameGroup {
  readonly name: string;
  readonly family: Family;
  readonly members: readonly Unit[];
}

/**
 * Channel one: the same name declared in two trees.
 *
 * The cheapest channel and the one with the highest recall here — it matched all eight known
 * forks, including three hex encoders that share almost no text. A copy usually keeps its name,
 * because the author copied it to do the same job.
 */
export function sameName(units: readonly Unit[]): NameGroup[] {
  const byName = new Map<string, Unit[]>();
  for (const unit of units) {
    if (!unit.topLevel) continue;
    // A constructor is named by the language, not by whoever wrote it, so the match carries no
    // information: every class in the tree would join one group of sixteen.
    if (unit.name === 'constructor') continue;
    const list = byName.get(unit.name);
    if (list) list.push(unit);
    else byName.set(unit.name, [unit]);
  }

  const groups: NameGroup[] = [];
  for (const [name, members] of byName) {
    if (new Set(members.map((unit) => unit.scope)).size < 2) continue;
    const sorted = members
      .slice()
      .sort((a, b) =>
        a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line,
      );
    groups.push({ name, family: familyOf(sorted), members: sorted });
  }
  return groups.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export interface ValueGroup {
  readonly text: string;
  readonly family: Family;
  readonly members: readonly ValueUnit[];
}

/**
 * Channel two: the same literal written out in two files.
 *
 * A copied regex shares no function with its original, so neither of the other channels can see
 * it. This is the channel that catches a validator drifting apart from the thing it validates.
 */
export function duplicatedValues(values: readonly ValueUnit[]): ValueGroup[] {
  const byText = new Map<string, ValueUnit[]>();
  for (const value of values) {
    const list = byText.get(value.text);
    if (list) list.push(value);
    else byText.set(value.text, [value]);
  }

  const groups: ValueGroup[] = [];
  for (const [text, members] of byText) {
    if (new Set(members.map((value) => value.file)).size < 2) continue;
    const sorted = members
      .slice()
      .sort((a, b) =>
        a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line,
      );
    groups.push({ text, family: familyOf(sorted), members: sorted });
  }
  return groups.sort((a, b) => (a.text < b.text ? -1 : 1));
}

/**
 * Below this many tokens a body is too small to mean anything by similarity alone.
 *
 * `encodeOperation` is a six-token delegation to the lab's own `encodeAmounts` and scores a
 * perfect 1.000 against its twin; so does every one-line accessor in the tree. Short units are
 * the name channel's and the value channel's business. Re-measured over the rigs 2026-07-31:
 * every cross-boundary pair a floor of 15 or 20 admits is a fragment of a family already filed
 * (`run`, `make`, `set`, `b64url`, `send`), a twin the name channel already admits (`is`,
 * `bearerOf`), or a one-expression accessor — no new family, at forty percent more comparisons.
 */
export const MIN_TOKENS = 25;

/**
 * Dice over 4-gram shingles for a SHIPPED pair, and the reason this number is not higher.
 *
 * Measured across every cross-boundary pair in the shipped trees: 0.80 drops the two base64url
 * encoders, which are renamed copies and the whole reason the near-match channel exists. 0.70
 * adds seven more engine twins and nothing else. 0.75 is the highest threshold that still holds
 * the renamed copies. Raising it needs a new measurement, not a preference.
 */
export const DICE_THRESHOLD = 0.75;

/**
 * Dice over the kept-literal stream for a RIG-INVOLVED pair.
 *
 * The collapsed stream cannot be scored at one threshold over both populations: collapsing is
 * what lets the engines' twins match through their driver names, and in a rig it makes two
 * fixture builders that share only a shape score 1.000. So a rig-involved pair is scored with
 * literals kept, and the threshold was measured over that population 2026-07-31: the four
 * shape-not-copy pairs score 0.235–0.500 kept, the known real rig forks 0.537–0.914, and 0.52
 * sits in the gap. The lowest-scoring pair that surfaces at all is `within` against `within` at
 * 0.530 — an admitted pair of deliberate opposites, not a fork — and the ceiling of the shape
 * range is a `sampleEvent` twin at 0.500, so either population drifting 0.03 moves a pair across
 * the line and into a decision. A verbatim copy scores 1.000 here, because it shares
 * its literals too — that is the case the kept stream was chosen to keep seeing, and the one
 * example this tree had was extracted to a shared home. Moving the number needs a new
 * measurement over both ranges, not a preference.
 */
export const DICE_THRESHOLD_RIG = 0.52;

const SHINGLE = 4;

/**
 * The four-token windows of a stream, each flattened to one comparable string.
 *
 * The join is on U+0000 because no token can contain it — a scanner emits identifiers, operators
 * and literal text, none of which carry a NUL — so no two different windows can flatten to the
 * same string. Any printable separator can occur inside a string literal and would let one window
 * forge another's key. It is written as the `\0` escape and never as the raw byte: a raw one makes
 * the whole file binary to `grep`, which then prints nothing at all rather than saying it skipped
 * it, and this file spent its life invisible to every sweep run over it for exactly that reason.
 */
const shinglesOf = (tokens: readonly string[]): Set<string> => {
  const set = new Set<string>();
  for (let i = 0; i + SHINGLE <= tokens.length; i += 1) {
    set.add(tokens.slice(i, i + SHINGLE).join('\0'));
  }
  return set;
};

const dice = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
};

/** Which instrument judged a pair, which also names the threshold that applies to it. */
export type Channel = 'shipped' | 'rig';

export interface Pair {
  readonly family: Family;
  /** `shipped` pairs are scored on the collapsed stream, `rig`-involved pairs on the kept one. */
  readonly channel: Channel;
  readonly dice: number;
  readonly left: Unit;
  readonly right: Unit;
}

export interface NearMatch {
  readonly pairs: readonly Pair[];
  /** Pairs that survived the length prune and were actually scored. */
  readonly pairsCompared: number;
}

/** The threshold a pair is judged against, decided by the trees its two units sit in. */
export const thresholdFor = (channel: Channel): number =>
  channel === 'rig' ? DICE_THRESHOLD_RIG : DICE_THRESHOLD;

/**
 * Channel three: bodies that survive being renamed.
 *
 * The expensive channel, and the only one that sees a copy whose author changed its name. It
 * found `faulted`, which is the lab's `faultResponse` with one parameter renamed, sitting in a
 * file nobody had flagged. A pair with a rig on either side is scored on the kept-literal
 * stream against `DICE_THRESHOLD_RIG`; a shipped pair on the collapsed stream against
 * `DICE_THRESHOLD` — the two measurements are on the constants.
 */
export function nearMatches(units: readonly Unit[]): NearMatch {
  const scored = units
    .filter((unit) => unit.tokens.length >= MIN_TOKENS)
    .map((unit) => ({
      unit,
      collapsed: shinglesOf(unit.tokens),
      kept: shinglesOf(unit.kept),
    }));

  const pairs: Pair[] = [];
  let pairsCompared = 0;
  for (let i = 0; i < scored.length; i += 1) {
    for (let j = i + 1; j < scored.length; j += 1) {
      const left = scored[i]!;
      const right = scored[j]!;
      if (left.unit.scope === right.unit.scope) continue;
      const lengths = [left.unit.tokens.length, right.unit.tokens.length];
      if (Math.min(...lengths) / Math.max(...lengths) < 0.5) continue;
      pairsCompared += 1;
      const channel: Channel =
        left.unit.tree === 'rig' || right.unit.tree === 'rig'
          ? 'rig'
          : 'shipped';
      const score =
        channel === 'rig'
          ? dice(left.kept, right.kept)
          : dice(left.collapsed, right.collapsed);
      if (score < thresholdFor(channel)) continue;
      pairs.push({
        family: familyOf([left.unit, right.unit]),
        channel,
        dice: score,
        left: left.unit,
        right: right.unit,
      });
    }
  }
  return {
    pairs: pairs.sort(
      (a, b) => b.dice - a.dice || (keyOf(a.left) < keyOf(b.left) ? -1 : 1),
    ),
    pairsCompared,
  };
}
