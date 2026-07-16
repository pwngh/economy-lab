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
 * Progressive enhancer for runnable snippet blocks (built to /runner/loader.js). Reveals each
 * block's toolbar and makes the code editable on click; everything heavier loads on intent —
 * the engine on the first run, the workbench (editor overlay, sandbox, transpiler) when the
 * reader touches the code. With JS off the blocks stay plain highlighted code.
 */

declare global {
  interface Window {
    __elabRunner?: boolean;
  }
}

// One <script> per runnable block; only the first activates.
if (!window.__elabRunner) {
  window.__elabRunner = true;

  for (const block of document.querySelectorAll<HTMLElement>('[data-snippet]')) {
    const button = block.querySelector<HTMLButtonElement>('[data-run]');
    const bar = block.querySelector<HTMLElement>('[data-bar]');
    const out = block.querySelector<HTMLElement>('[data-out]');
    if (!button || !bar || !out) continue;
    block.dataset.state = 'idle';
    bar.hidden = false;
    // With no Edit button, the affordance needs a word; the workbench replaces this on entry.
    const note = block.querySelector<HTMLElement>('[data-note]');
    if (note) note.textContent = 'The code is editable — click into it.';

    button.addEventListener('click', async () => {
      button.disabled = true;
      block.dataset.state = 'running';
      out.hidden = false;
      out.setAttribute('aria-busy', 'true');
      try {
        if (block.dataset.mode === 'edit') {
          const workbench = await import('./workbench.js');
          await workbench.runEdited(block, out);
        } else {
          const engine = await import('./engine.js');
          await engine.runSnippet(block);
        }
        block.dataset.state = 'done';
        button.textContent = 'Run again';
        button.disabled = false;
      } catch {
        block.dataset.state = 'error';
        out.textContent = 'The demo engine failed to load — the page is unaffected.';
      } finally {
        out.removeAttribute('aria-busy');
      }
    });

    // The code is the editor: hovering warms the workbench chunk; a click swaps it in with the
    // caret where the reader aimed. Keyboard users opt in with Enter — a mere tab-through must
    // never convert the block or trap focus.
    const code = block.querySelector<HTMLElement>('.runnable-code');
    if (code) {
      code.tabIndex = 0;
      code.setAttribute('role', 'button');
      code.setAttribute('aria-label', 'Snippet code — press Enter to edit');
      code.addEventListener('pointerenter', () => void import('./workbench.js'), { once: true });
      const open = async (event?: MouseEvent) => {
        (await import('./workbench.js')).enterEdit(block, event);
      };
      code.addEventListener('click', (event) => void open(event));
      code.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void open();
        }
      });
    }
    // Copies the editor's current text, or the shipped source before any edit.
    block.querySelector<HTMLButtonElement>('[data-copy]')?.addEventListener('click', async () => {
      const editor = block.querySelector<HTMLTextAreaElement>('.runnable-editor');
      try {
        await navigator.clipboard.writeText(
          editor ? editor.value : (code?.textContent ?? '').trim(),
        );
      } catch {
        return; // clipboard denied: leave the note untouched rather than claim success
      }
      if (note) {
        const prior = note.textContent;
        note.textContent = 'Copied';
        setTimeout(() => {
          if (note.textContent === 'Copied') note.textContent = prior;
        }, 1500);
      }
    });
    block
      .querySelector<HTMLButtonElement>('[data-reset-code]')
      ?.addEventListener('click', async () => {
        (await import('./workbench.js')).resetCode(block);
      });
    block
      .querySelector<HTMLButtonElement>('[data-reset-economy]')
      ?.addEventListener('click', async () => {
        (await import('./workbench.js')).resetEconomy(out);
      });
  }
}

export {};
