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

// Collects every docs↔source chip and resolves it against the library working tree. A chip is
// `path[#Lstart[-Lend]][ · label]`, written either as a frontmatter `sourceRefs` entry or as a
// <SourceLink> in prose.
//
// The rule a chip has to satisfy:
//
//   file only                the file exists. That is the whole claim, so that is the whole check.
//   file only + label        the symbol is declared somewhere in the file.
//   `#Lnn` + label           line nn declares the symbol.
//   `#La-Lb` + label         the span contains the symbol's declaration, or lies inside it.
//
// A point chip claims the symbol is HERE, so it has to land on the declaration. A span chip claims
// these lines BELONG TO the symbol, so it may sit inside the body — which is how a chip aimed at
// one guard inside a long function stays precise. Neither can be satisfied by the label merely
// occurring in the range: a mention in a doc comment, an `@example`, a URL, or a longer word that
// contains the label is not a declaration, and every one of those has passed for a stale chip here.
//
// An inline <SourceLink>'s own text counts as its label, so `<SourceLink to="src/chain.ts#L40">
// ChainLink</SourceLink>` is checked without changing the `to` grammar. A chip that names nothing
// checkable — a span with no `· label` and no symbol in its text — fails; write the label.
//
// Bare Node only, so a test or script can drive it without the bundler.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import ts from 'typescript';

export const CONTENT_DIR = fileURLToPath(new URL('./content', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Where the chip was written. Frontmatter carries its label in `to`; prose may carry it as text. */
export type ChipForm = 'sourceRefs' | 'SourceLink';

export type Chip = {
  /** Content-relative mdx path, forward slashes. */
  page: string;
  /** 1-based line of the chip in the mdx file. */
  line: number;
  form: ChipForm;
  /** The chip string as written. */
  raw: string;
  /** Repo-relative source path. */
  path: string;
  start: number | null;
  end: number | null;
  label: string | null;
  /** `to` when the label came from `· label`, `text` when it came from the element's own text. */
  labelFrom: 'to' | 'text' | null;
};

export type Inventory = {
  /** Content-relative mdx paths walked, sorted. */
  pages: string[];
  /** `sourceRefs` entries gray-matter found, before parsing. */
  frontmatterEntries: number;
  /** `<SourceLink` occurrences in the raw text, before parsing. */
  sourceLinkTags: number;
  chips: Chip[];
  /** Chip strings the grammar could not parse. Never allowed to be non-empty. */
  unparsed: string[];
};

const REF_SHAPE = /^([^#\s·]+)(?:#L(\d+)(?:-L(\d+))?)?(?:\s*·\s*(.+))?$/;
const SOURCE_LINK = /<SourceLink\s+to="([^"]+)"\s*(\/>|>)/g;

function walkMdx(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.split('\\').join('/'))
    .sort();
}

/** 1-based line of the first occurrence of `needle`, or 0 when it is not found verbatim. */
function lineOf(text: string, needle: string, from = 0): number {
  const at = text.indexOf(needle, from);
  return at === -1 ? 0 : text.slice(0, at).split('\n').length;
}

function parse(raw: string): Omit<Chip, 'page' | 'line' | 'form' | 'labelFrom'> | null {
  const m = REF_SHAPE.exec(raw.trim());
  if (!m?.[1]) return null;
  const start = m[2] ? Number(m[2]) : null;
  return {
    raw,
    path: m[1],
    start,
    end: m[3] ? Number(m[3]) : start,
    label: m[4] ? m[4].trim() : null,
  };
}

/**
 * Walks the content tree and parses every chip. `sourceRefs` comes from the parsed frontmatter
 * rather than a quoted-string scan, so an entry cannot hide behind its quoting or behind a path
 * prefix the scanner did not know about — six `· kind 'topUp'` chips did exactly that. The raw
 * counters let a caller assert the parse saw everything it was handed.
 */
export function collectChips(contentDir = CONTENT_DIR): Inventory {
  const pages = walkMdx(contentDir);
  const inventory: Inventory = {
    pages,
    frontmatterEntries: 0,
    sourceLinkTags: 0,
    chips: [],
    unparsed: [],
  };
  for (const page of pages) {
    const text = readFileSync(join(contentDir, page), 'utf8');
    const { data } = matter(text);
    const refs: string[] = Array.isArray(data.sourceRefs) ? data.sourceRefs.map(String) : [];
    inventory.frontmatterEntries += refs.length;
    for (const raw of refs) {
      const parsed = parse(raw);
      if (!parsed) {
        inventory.unparsed.push(`${page}: ${raw}`);
        continue;
      }
      inventory.chips.push({
        ...parsed,
        page,
        line: lineOf(text, raw),
        form: 'sourceRefs',
        labelFrom: parsed.label ? 'to' : null,
      });
    }
    inventory.sourceLinkTags += (text.match(/<SourceLink\b/g) ?? []).length;
    for (const m of text.matchAll(SOURCE_LINK)) {
      const raw = m[1] ?? '';
      const parsed = parse(raw);
      if (!parsed) {
        inventory.unparsed.push(`${page}: ${raw}`);
        continue;
      }
      let text_: string | null = null;
      if (m[2] === '>') {
        const after = text.slice((m.index ?? 0) + m[0].length);
        const close = after.indexOf('</SourceLink>');
        if (close >= 0) text_ = after.slice(0, close).replace(/\s+/g, ' ').trim();
      }
      inventory.chips.push({
        ...parsed,
        page,
        line: lineOf(text, m[0]),
        form: 'SourceLink',
        label: parsed.label ?? text_,
        labelFrom: parsed.label ? 'to' : text_ ? 'text' : null,
      });
    }
  }
  return inventory;
}

/** One named thing a source file declares, with the extent that belongs to it. */
export type Declaration = {
  name: string;
  /** 1-based line the name sits on. */
  line: number;
  /** First line of the declaration itself — its leading doc comment is deliberately outside. */
  from: number;
  /** Last line of the declaration, its body included. */
  to: number;
};

const TS_FILE = /\.[cm]?[jt]sx?$/;
const SQL_FILE = /\.sql$/;

// `create [or replace] [unique] <kind> <name>`, `constraint <name>`, `alter table <name>`. A SQL
// object has no body the parser can bound, so `from`/`to` are the defining line itself.
const SQL_DEFINITION =
  /\b(?:create(?:\s+or\s+replace)?(?:\s+unique)?\s+(?:table|index|view|trigger|constraint\s+trigger|function|procedure|type|schema|sequence|materialized\s+view)|constraint|alter\s+table)\s+(?:if\s+not\s+exists\s+)?["`]?([A-Za-z_][\w$]*)/i;

function tsDeclarations(file: string, text: string): Declaration[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Declaration[] = [];
  const lineAt = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const add = (name: ts.Node | undefined, node: ts.Node) => {
    if (!name) return;
    let text_: string | null = null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) text_ = name.text;
    else if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) text_ = name.text;
    if (text_ === null) return;
    out.push({
      name: text_,
      line: lineAt(name.getStart(source)),
      // getStart skips leading trivia, so a doc comment above a declaration is outside its extent.
      // That is deliberate: a chip that lands in the doc block is the drift this gate exists for.
      from: lineAt(node.getStart(source)),
      to: lineAt(node.end),
    });
    // A discriminant declares its variant. `kind: 'topUp'` inside a tagged union is the one line
    // that belongs to the topUp operation, and the six operation pages point at exactly that line;
    // without this they could only claim `kind`, which every variant in the union also declares.
    const literal = ts.isPropertySignature(node)
      ? node.type
      : ts.isPropertyAssignment(node)
        ? node.initializer
        : undefined;
    const value = literal
      ? ts.isLiteralTypeNode(literal) && ts.isStringLiteral(literal.literal)
        ? literal.literal.text
        : ts.isStringLiteral(literal)
          ? literal.text
          : null
      : null;
    if (value !== null && /^[A-Za-z_$][\w$]*$/.test(value)) {
      out.push({
        name: value,
        line: lineAt(name.getStart(source)),
        from: lineAt(node.getStart(source)),
        to: lineAt(node.end),
      });
    }
  };
  const walk = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isEnumMember(node) ||
      ts.isVariableDeclaration(node) ||
      // A re-export names the symbol at the package door, which is a place a chip may point.
      ts.isExportSpecifier(node)
    ) {
      add(node.name, node);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

const cache = new Map<string, { lines: number; declarations: Declaration[] | null }>();

/**
 * Every declaration in a source file. `null` declarations means the file is a kind this gate
 * cannot read, which makes any labeled chip into it fail rather than pass unexamined.
 */
export function readSource(file: string): { lines: number; declarations: Declaration[] | null } {
  const hit = cache.get(file);
  if (hit) return hit;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  let declarations: Declaration[] | null = null;
  if (TS_FILE.test(file)) declarations = tsDeclarations(file, text);
  else if (SQL_FILE.test(file)) {
    declarations = [];
    lines.forEach((line, i) => {
      const m = SQL_DEFINITION.exec(line);
      if (m?.[1]) declarations?.push({ name: m[1], line: i + 1, from: i + 1, to: i + 1 });
    });
  }
  const value = { lines: lines.length, declarations };
  cache.set(file, value);
  return value;
}

/**
 * The identifier a label points at: its last identifier-shaped word. A label reads outside-in, so
 * `Economy.read` points at `read` and `kind 'topUp'` points at `topUp`. Taking the last word rather
 * than any word is what keeps `kind 'reverse'` from resolving against a neighbouring variant's own
 * `kind`, which is the short-label hole this gate was rewritten to close. Null when the label
 * contains no identifier at all.
 */
export function labelTarget(label: string): string | null {
  return [...label.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).at(-1) ?? null;
}

export type ResolutionContext = {
  repoRoot: string;
  /** Injectable for tests; defaults to disk. */
  read: (file: string) => { lines: number; declarations: Declaration[] | null };
  exists: (file: string) => boolean;
};

export function defaultContext(repoRoot = REPO_ROOT): ResolutionContext {
  return { repoRoot, read: readSource, exists: existsSync };
}

/**
 * Resolves one chip; `null` means it lands. Everything else is the sentence the gate prints, which
 * names where the symbol actually is whenever it can find it — a stale chip should report the
 * number that repairs it, not just that it is wrong.
 */
export function resolveChip(chip: Chip, ctx: ResolutionContext): string | null {
  const file = join(ctx.repoRoot, chip.path);
  if (!ctx.exists(file)) return `no such file: ${chip.path}`;

  const { lines, declarations } = ctx.read(file);
  const target = chip.label ? labelTarget(chip.label) : null;
  const found = (declarations ?? []).filter((d) => d.name === target);

  if (chip.start === null) {
    // A file-only chip claims a file and nothing more. With a label it claims a symbol too.
    if (!chip.label) return null;
    if (declarations === null)
      return `${chip.path} is a file kind this gate cannot read symbols in`;
    if (target === null) return `\`${chip.label}\` names no identifier`;
    if (found.length > 0) return null;
    return `${chip.path} declares no ${target}`;
  }

  const start = chip.start;
  const end = chip.end ?? start;
  if (start < 1 || end < start) return `nonsense range #L${start}-L${end}`;
  if (end > lines) return `#L${start}-L${end} runs past ${chip.path}, which has ${lines} lines`;

  if (!chip.label) {
    return chip.form === 'SourceLink'
      ? 'names no symbol — give it a `· label` in `to`, or name the symbol in the link text'
      : 'names no symbol — a chip with a line range must carry a `· label`';
  }
  if (declarations === null) return `${chip.path} is a file kind this gate cannot read symbols in`;
  if (target === null) return `\`${chip.label}\` names no identifier`;
  if (found.length === 0) return `${chip.path} declares no ${target}`;

  const point = start === end;
  if (found.some((d) => d.line >= start && d.line <= end)) return null;
  // A span may sit inside the declaration it names; a single line may not, because pointing at one
  // line claims the declaration is on it.
  if (!point && found.some((d) => d.from <= start && end <= d.to)) return null;

  const where = [...found]
    .sort((a, b) => Math.abs(a.line - start) - Math.abs(b.line - start))
    .slice(0, 3)
    .map((d) => `L${d.line}`)
    .join(', ');
  return point
    ? `L${start} does not declare ${target} — it is declared at ${where}`
    : `#L${start}-L${end} neither contains nor sits inside ${target} — declared at ${where}`;
}
