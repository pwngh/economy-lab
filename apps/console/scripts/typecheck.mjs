/**
 * typecheck wrapper.
 *
 * tsc also checks the engine source it can reach under ../../src, which is validated separately at
 * the repo root (its own tsconfig: lib esnext, types [], wintercg.d.ts). Re-checking it here under
 * this app's DOM lib throws a couple of false positives — crypto/Uint8Array buffer-generic
 * mismatches (mostly handled by engine-shim.d.ts) and an unused @ts-expect-error in the optional
 * redis adapter. So: run tsc, then report only errors in this app's own files.
 */
import { spawnSync } from 'node:child_process';

const res = spawnSync('npx', ['tsc', '--pretty', 'false'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
const lines = out.split('\n');

// Keep only diagnostics pointing at an app-owned file (not the engine source under ../../src).
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
