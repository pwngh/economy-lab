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

// Every inline <ApiLink> and frontmatter `apiRefs` entry must resolve into the generated TypeDoc
// output: the page file exists under docs/, and a `#member` anchor's id is present in it. TypeDoc
// regenerates from this same tree, so a failure here means a symbol was renamed or an entry point
// dropped — not a stale pin. Run `npm run docs:api` first if docs/ is absent.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const API_OUT = resolve(__dirname, '../../../docs');
const CONTENT = join(__dirname, 'content');

type ApiRef = { page: string; ref: string; path: string; member: string | null };

function mdxFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => join(dir, f));
}

// An entry is `kindDir/Module.Symbol[#member]` from an inline ApiLink `to` or an `apiRefs` item;
// module pages (`src_netting`) have no kind directory.
function refsOf(page: string): ApiRef[] {
  const text = readFileSync(page, 'utf8');
  const raws = [...text.matchAll(/<ApiLink to="([^"]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const list = /apiRefs:\s*\[([^\]]*)\]/.exec(front)?.[1] ?? '';
  raws.push(...[...list.matchAll(/'([^']+)'/g)].flatMap((m) => (m[1] ? [m[1]] : [])));
  return raws.map((raw) => {
    const [path = '', member] = raw.split('#');
    return { page, ref: raw, path, member: member ?? null };
  });
}

const allRefs = mdxFiles(CONTENT).flatMap(refsOf);

describe('docs↔api links resolve against the generated reference', () => {
  test('the TypeDoc output exists', () => {
    expect(existsSync(join(API_OUT, 'index.html')), 'run npm run docs:api first').toBe(true);
  });

  for (const ref of allRefs) {
    const name = `${ref.page.split('/content/')[1]} → ${ref.ref}`;
    test(name, () => {
      const file = join(API_OUT, `${ref.path}.html`);
      expect(existsSync(file), `no generated page: ${ref.path}.html`).toBe(true);
      if (!ref.member) return;
      const html = readFileSync(file, 'utf8');
      expect(
        html.includes(`id="${ref.member}"`),
        `no anchor #${ref.member} in ${ref.path}.html`,
      ).toBe(true);
    });
  }
});
