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
 * The workbench: edit a runnable block's code and run the edit for real. Loaded only when the
 * reader presses Edit. Edited code executes inside the /runner/sandbox.html iframe — the one
 * document whose CSP permits eval — and the operations it submits come back and join the same
 * journal shipped runs write, so the console handoff stays true for the reader's own code.
 */

import { clearJournal, loadJournal, saveJournal } from '../../console/app/journal';
import { renderRun } from './render';

import type { SandboxResult } from './sandbox-protocol';

const originals = new WeakMap<HTMLElement, string>();

let sandboxFrame: Promise<Window> | null = null;
let seq = 0;
const pending = new Map<number, (result: SandboxResult) => void>();

// One hidden iframe per page, created on the first edited run. Replies are matched by reqId and
// accepted only from that frame on this origin — the sandbox's whole input surface is this
// postMessage channel.
function sandbox(): Promise<Window> {
  sandboxFrame ??= new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.src = '/runner/sandbox.html';
    frame.style.display = 'none';
    frame.setAttribute('title', 'economy-lab code sandbox');
    frame.setAttribute('aria-hidden', 'true');
    frame.addEventListener('load', () => {
      const win = frame.contentWindow;
      if (!win) {
        reject(new Error('sandbox failed to load'));
        return;
      }
      window.addEventListener('message', (event) => {
        if (event.origin !== location.origin || event.source !== win) return;
        const result = event.data as SandboxResult;
        const settle = pending.get(result?.reqId);
        if (settle) {
          pending.delete(result.reqId);
          settle(result);
        }
      });
      resolve(win);
    });
    frame.addEventListener('error', () => reject(new Error('sandbox failed to load')));
    document.body.appendChild(frame);
  });
  return sandboxFrame;
}

function editorOf(block: HTMLElement): HTMLTextAreaElement | null {
  return block.querySelector<HTMLTextAreaElement>('.runnable-editor');
}

// Just enough TypeScript coloring for the editing overlay: comments, strings, numbers, keywords.
// The read view is real Shiki; this only has to keep the reader oriented while they type.
const TS_TOKENS =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\[\s\S])*`?|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|\b(\d[\d_]*n?)\b|\b(async|await|catch|const|else|export|for|from|function|if|import|in|interface|let|new|of|return|throw|try|type|typeof|var)\b/g;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightTs(code: string): string {
  let out = '';
  let last = 0;
  for (const m of code.matchAll(TS_TOKENS)) {
    out += escapeHtml(code.slice(last, m.index));
    const cls = m[1] ? 'tok-comment' : m[2] ? 'tok-string' : m[3] ? 'tok-number' : 'tok-keyword';
    out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(code.slice(last));
}

// Tab indents and Enter carries the current line's indentation, so editing doesn't fight the
// reader. execCommand keeps the browser's undo stack; the fallback loses it but still types.
function insertAtCaret(editor: HTMLTextAreaElement, text: string): void {
  if (!document.execCommand('insertText', false, text)) {
    editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input'));
  }
}

function editorKeys(event: KeyboardEvent): void {
  const editor = event.target as HTMLTextAreaElement;
  if (event.key === 'Escape') {
    // Tab is indentation in here, so Escape is the keyboard exit: focus lands on Run.
    editor.closest('[data-snippet]')?.querySelector<HTMLButtonElement>('[data-run]')?.focus();
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    editor.closest('[data-snippet]')?.querySelector<HTMLButtonElement>('[data-run]')?.click();
  } else if (event.key === 'Tab' && !event.shiftKey) {
    event.preventDefault();
    insertAtCaret(editor, '  ');
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const upToCaret = editor.value.slice(0, editor.selectionStart);
    const line = upToCaret.slice(upToCaret.lastIndexOf('\n') + 1);
    const indent = /^ */.exec(line)?.[0] ?? '';
    insertAtCaret(editor, `\n${indent}`);
  }
}

// The reader clicked somewhere in the highlighted code; find the same spot in the plain source
// so the caret lands where they aimed. Walks the text nodes up to the hit, summing lengths.
function caretOffsetAt(container: HTMLElement, x: number, y: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    if (!position) return null;
    node = position.offsetNode;
    offset = position.offset;
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (!range) return null;
    node = range.startContainer;
    offset = range.startOffset;
  }
  if (!node || !container.contains(node)) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text === node) return total + offset;
    total += text.textContent?.length ?? 0;
  }
  return null;
}

export function enterEdit(block: HTMLElement, event?: MouseEvent): void {
  const existing = editorOf(block);
  if (existing) {
    existing.focus();
    return;
  }
  const pre = block.querySelector<HTMLElement>('.runnable-code');
  if (!pre) return;
  const caret = event ? caretOffsetAt(pre, event.clientX, event.clientY) : null;
  const source = (pre.textContent ?? '').trim();
  originals.set(block, source);

  // The editor is a transparent-text textarea over a token-painted layer — highlighted editing
  // with no editor library, and the textarea stays the single source of truth.
  const wrap = document.createElement('div');
  wrap.className = 'runnable-editwrap';
  const backdrop = document.createElement('pre');
  backdrop.className = 'runnable-editor-hl';
  backdrop.setAttribute('aria-hidden', 'true');
  const editor = document.createElement('textarea');
  editor.className = 'runnable-editor';
  editor.value = source;
  editor.rows = source.split('\n').length + 1;
  editor.spellcheck = false;
  editor.setAttribute('aria-label', 'Editable snippet code');
  wrap.append(backdrop, editor);

  const resetCode = block.querySelector<HTMLButtonElement>('[data-reset-code]');
  const paint = () => {
    backdrop.innerHTML = highlightTs(editor.value);
    backdrop.scrollTop = editor.scrollTop;
    backdrop.scrollLeft = editor.scrollLeft;
    // The code reset exists only while there's an edit to undo.
    if (resetCode) resetCode.hidden = editor.value === source;
  };
  editor.addEventListener('input', paint);
  editor.addEventListener('scroll', () => {
    backdrop.scrollTop = editor.scrollTop;
    backdrop.scrollLeft = editor.scrollLeft;
  });
  editor.addEventListener('keydown', editorKeys);
  paint();

  pre.hidden = true;
  pre.after(wrap);

  block.dataset.mode = 'edit';
  const note = block.querySelector<HTMLElement>('[data-note]');
  if (note) {
    note.textContent =
      'Edits run type-stripped — ⌘↩ runs, Esc leaves the editor; faults print their real codes.';
  }
  editor.focus();
  if (caret !== null) {
    const at = Math.min(caret, editor.value.length);
    editor.setSelectionRange(at, at);
  }
}

export async function runEdited(block: HTMLElement, out: HTMLElement): Promise<void> {
  const editor = editorOf(block);
  if (!editor) return;
  const started = performance.now();
  const win = await sandbox();
  const reqId = ++seq;
  // Belt to the sandbox's own watchdog: if the sandbox document itself can't answer (blocked
  // frame, broken build), the run must fail honestly rather than hang the block forever.
  const result = await new Promise<SandboxResult>((resolve) => {
    const bail = setTimeout(() => {
      pending.delete(reqId);
      resolve({
        reqId,
        lines: [],
        logs: [],
        ops: [],
        error: 'The sandbox did not answer within 15 s — reload the page and try again.',
      });
    }, 15_000);
    pending.set(reqId, (settled) => {
      clearTimeout(bail);
      resolve(settled);
    });
    win.postMessage(
      { type: 'run', reqId, code: editor.value, journal: loadJournal() },
      location.origin,
    );
  });

  const total = loadJournal().length + result.ops.length;
  if (result.ops.length > 0) {
    saveJournal([...loadJournal(), ...result.ops]);
    window.dispatchEvent(new Event('elab:journal-changed'));
  }

  renderRun(out, {
    lines: result.lines,
    logs: result.logs,
    fault: result.error,
    txnId: result.txnId,
    consolePath: result.consolePath,
    ms: Math.max(1, Math.round(performance.now() - started)),
    added: result.ops.length,
    total,
  });
}

export function resetCode(block: HTMLElement): void {
  const editor = editorOf(block);
  const source = originals.get(block);
  if (editor && source !== undefined) {
    editor.value = source;
    editor.dispatchEvent(new Event('input')); // repaint the overlay
    editor.focus();
  }
}

export function resetEconomy(out: HTMLElement): void {
  clearJournal();
  window.dispatchEvent(new Event('elab:journal-changed'));
  out.hidden = false;
  out.textContent = '';
  const div = document.createElement('div');
  div.className = 'runnable-line';
  div.textContent = 'economy reset to its seed — the journal is empty';
  out.appendChild(div);
}
