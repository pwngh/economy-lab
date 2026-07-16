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
 * One renderer for every run's output, shipped or edited, so the three channels always look the
 * same: result lines, a fault carrying its real reason code, and anything the reader's own code
 * logged.
 */

export interface RunView {
  lines: string[];
  logs?: string[];
  fault?: string;
  txnId?: string;
  consolePath?: string;
  ms: number;
  added: number;
  total: number;
}

export function renderRun(out: HTMLElement, view: RunView): void {
  out.textContent = '';
  for (const line of view.lines) {
    const div = document.createElement('div');
    div.className = 'runnable-line';
    div.textContent = line;
    out.appendChild(div);
  }
  for (const line of view.logs ?? []) {
    const div = document.createElement('div');
    div.className = 'runnable-log';
    div.textContent = line;
    out.appendChild(div);
  }
  if (view.fault !== undefined) {
    const div = document.createElement('div');
    div.className = 'runnable-fault';
    div.textContent = view.fault;
    out.appendChild(div);
  }

  const foot = document.createElement('div');
  foot.className = 'runnable-foot';
  const meta = document.createElement('span');
  meta.className = 'runnable-metaline';
  meta.textContent = `ran in ${view.ms} ms · ${view.added} operation${view.added === 1 ? '' : 's'} journaled (${view.total} in the handoff)`;
  // The economy reset sits beside the journal count it clears; it delegates to the block's
  // hidden header button so the loader's one binding stays the only wiring.
  const resetTarget = out
    .closest('[data-snippet]')
    ?.querySelector<HTMLButtonElement>('[data-reset-economy]');
  if (resetTarget) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'runnable-footreset';
    reset.textContent = 'reset economy';
    reset.addEventListener('click', () => resetTarget.click());
    meta.append(' · ', reset);
  }
  const link = document.createElement('a');
  link.className = 'runnable-jump';
  if (view.txnId) {
    link.href = `/console/ledger/txn/${encodeURIComponent(view.txnId)}?from=docs`;
    link.textContent = `open ${view.txnId} in the console`;
  } else {
    const path = view.consolePath ?? '/ledger';
    link.href = `/console${path}?from=docs`;
    link.textContent = `open ${path.replace('/', '')} in the console`;
  }
  foot.append(meta, link);
  out.appendChild(foot);
}
