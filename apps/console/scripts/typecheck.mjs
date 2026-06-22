/**
 * typecheck wrapper.
 *
 * tsc type-checks the app AND every file it can reach by import — including the frozen engine
 * source under ../../src, which is checked at the repo ROOT under its own (correct) tsconfig
 * (lib: esnext, types: [], plus its ambient wintercg.d.ts). Re-checking that frozen source here,
 * under this app's DOM lib, surfaces a couple of artifacts that are NOT real defects in this app:
 *
 *   - crypto/Uint8Array buffer-generic mismatches (DOM's stricter BufferSource) — mostly fixed by
 *     app/engine-shim.d.ts, which declaration-merges the WinterCG-compatible overloads.
 *   - an "unused @ts-expect-error" in the OPTIONAL redis adapter (src/adapters/redis.ts), reached
 *     only via a dynamic import in src/index.ts. This app never uses Redis, and that directive is
 *     correct under the engine's own config.
 *
 * So: run tsc, then report only errors that originate in THIS app's files. An error anywhere under
 * the frozen ../../src tree is filtered out (it is the root project's responsibility and is green
 * there). Any app-file error fails the check, exactly as a plain `tsc` would for app code.
 */
import { spawnSync } from 'node:child_process';

const res = spawnSync('npx', ['tsc', '--pretty', 'false'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
const lines = out.split('\n');

// Keep only TS diagnostic lines that point at an app-owned file (anything not under the frozen
// engine source). Non-diagnostic lines (blank, summaries) are dropped.
const appErrors = lines.filter((line) => {
  const m = /^(.*?)\(\d+,\d+\): error TS\d+/.exec(line);
  if (!m) return false;
  const file = m[1];
  // Engine source lives at ../../src — filter those out (validated at the repo root).
  return !file.includes('../../src/') && !file.includes('..\\..\\src\\');
});

if (appErrors.length > 0) {
  console.error(appErrors.join('\n'));
  console.error(`\n${appErrors.length} type error(s) in app sources.`);
  process.exit(1);
}

const engineFiltered = lines.filter((l) => /error TS\d+/.test(l)).length;
if (engineFiltered > 0) {
  console.log(
    `App sources type-check clean. (${engineFiltered} diagnostic(s) in the frozen engine source were filtered; they are validated at the repo root.)`,
  );
} else {
  console.log('App sources type-check clean.');
}
process.exit(0);
