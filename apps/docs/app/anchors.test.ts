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

// Guards the docs↔source link layer against rot. Every `sourceRefs` chip and inline <SourceLink>
// anchor resolves against the library working tree: the file exists, any `#Lnn` range falls inside
// it, and a labeled chip's symbol appears within that range. The chips render at REPO_REF, so this
// passes only while the tree matches the pin — edit the library source and this fails until the
// anchors are re-pointed and REPO_REF re-pinned (see app/repo.ts).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const CONTENT = join(__dirname, 'content');

type Ref = {
  page: string;
  ref: string;
  path: string;
  start: number | null;
  end: number | null;
  label: string | null;
};

// A chip is `path[#Lstart[-Lend]][ · label]`, in sourceRefs frontmatter or a SourceLink `to`.
const REF_SHAPE = /^([^#\s·]+)(?:#L(\d+)(?:-L(\d+))?)?(?:\s*·\s*(.+))?$/;

function mdxFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => join(dir, f));
}

function refsOf(page: string): Ref[] {
  const text = readFileSync(page, 'utf8');
  const out: Ref[] = [];
  const raws = [
    ...text.matchAll(/'((?:src|test|scripts|db)\/[^']+)'/g),
    ...text.matchAll(/<SourceLink to="([^"]+)"/g),
  ].flatMap((m) => (m[1] ? [m[1]] : []));
  for (const raw of raws) {
    const m = REF_SHAPE.exec(raw.trim());
    if (!m) continue;
    out.push({
      page,
      ref: raw,
      path: m[1] ?? '',
      start: m[2] ? Number(m[2]) : null,
      end: m[3] ? Number(m[3]) : null,
      label: m[4] ? m[4].trim() : null,
    });
  }
  return out;
}

// The page's operation kind (`revoke-entitlement` → `revokeEntitlement`) counts as a symbol too:
// REGISTRY chips anchor the page's own entry line, whose text is the kind, not "REGISTRY".
function pageKind(page: string): string {
  const stem = (page.split('/').at(-1) ?? page).replace('.mdx', '');
  return stem.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
}

const allRefs = mdxFiles(CONTENT).flatMap(refsOf);

describe('docs↔source anchors resolve against the library tree', () => {
  test('collected a non-trivial inventory', () => {
    expect(allRefs.length).toBeGreaterThan(100);
  });

  for (const ref of allRefs) {
    const name = `${ref.page.split('/content/')[1]} → ${ref.ref}`;
    test(name, () => {
      const file = join(REPO_ROOT, ref.path);
      expect(existsSync(file), `missing file: ${ref.path}`).toBe(true);
      if (ref.start === null) return;
      const lines = readFileSync(file, 'utf8').split('\n');
      const end = ref.end ?? ref.start;
      expect(ref.start, 'range starts before line 1').toBeGreaterThan(0);
      expect(end, `range ends past ${ref.path} (${lines.length} lines)`).toBeLessThanOrEqual(
        lines.length,
      );
      if (!ref.label) return;
      const range = lines.slice(ref.start - 1, end).join('\n');
      const tokens = [...ref.label.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
      const candidates = [...tokens, pageKind(ref.page)];
      const hit = candidates.some((t) => range.includes(t));
      expect(
        hit,
        `none of [${candidates.join(', ')}] found in ${ref.path}#L${ref.start}-L${end}`,
      ).toBe(true);
    });
  }
});
