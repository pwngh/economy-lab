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
 * block's Run button; the engine itself loads only on the first click, via dynamic import, so a
 * docs page costs nothing extra until someone actually runs code. With JS off the blocks stay
 * plain code.
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
    const out = block.querySelector<HTMLElement>('[data-out]');
    if (!button || !out) continue;
    block.dataset.state = 'idle';
    button.hidden = false;

    button.addEventListener('click', async () => {
      button.disabled = true;
      block.dataset.state = 'running';
      out.hidden = false;
      out.setAttribute('aria-busy', 'true');
      try {
        const engine = await import('./engine.js');
        await engine.runSnippet(block);
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
  }
}

export {};
