// Recursively lists every .html file under a directory — shared by check-csp and check-static.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.name.endsWith('.html')) out.push(full);
  }
  return out;
}
