/**
 * create-economy
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { createInterface } from 'node:readline/promises';
import { QUESTIONS, values } from './options.js';
import type { Question, Selection } from './options.js';

/** The reader's terminal, injectable so the questions are testable without one. */
export interface Asker {
  ask(question: string, fallback: string): Promise<string>;
  close(): void;
}

export function terminalAsker(): Asker {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (question, fallback) =>
      (await rl.question(`${question} (${fallback}) `)).trim() || fallback,
    close: () => rl.close(),
  };
}

/** True when a question can be answered; a piped stdin gets the refusal instead. */
export const interactive = (): boolean => process.stdin.isTTY === true;

export const askDirectory = (asker: Asker): Promise<string> =>
  asker.ask('directory', 'my-economy');

/** Re-asks until the answer is on the question's table, so a typo costs a line, not the run. */
async function askOne(asker: Asker, q: Question): Promise<string> {
  for (let tries = 0; tries < 5; tries += 1) {
    const answer = await asker.ask(
      `${q.ask} [${values(q.id).join('|')}]`,
      q.fallback,
    );
    if (values(q.id).includes(answer)) return answer;
  }
  return q.fallback;
}

/** Asks every question the command line left open, in table order. */
export async function askQuestions(
  asker: Asker,
  answered: Selection,
): Promise<Selection> {
  const out: Record<string, string> = { ...answered };
  for (const q of QUESTIONS) {
    if (out[q.id] === undefined) out[q.id] = await askOne(asker, q);
  }
  return out;
}
