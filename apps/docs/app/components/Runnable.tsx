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
 * A runnable snippet block. `code` is the snippet file itself (imported `?raw` by the page), so
 * what the reader sees is byte-for-byte what runs — the file is type-checked against the real
 * engine in CI. Prerendered as a plain titled code block; /runner/loader.js reveals the Run
 * button and loads the engine only on the first click. With JS off, it is exactly a code block.
 */
export function Runnable({ name, code }: { name: string; code: string }) {
  return (
    <figure className="runnable" data-snippet={name}>
      <figcaption className="runnable-head">
        <span className="runnable-dot" aria-hidden="true" />
        <span className="runnable-title">Live — runs the real engine in your browser</span>
        <button type="button" className="runnable-run" data-run hidden>
          Run
        </button>
      </figcaption>
      <pre className="runnable-code">
        <code>{code.trim()}</code>
      </pre>
      <output className="runnable-out" data-out hidden />
      <script type="module" src="/runner/loader.js" />
    </figure>
  );
}
