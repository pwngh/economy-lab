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

// The message shapes shared by the workbench (page side), the sandbox document (relay), and the
// sandbox worker (executor). Operations cross both hops by structured clone, bigints intact.

import type { JournalEntry } from '../../console/app/journal';

export interface RunRequest {
  type: 'run';
  reqId: number;
  code: string;
  journal: JournalEntry[];
}

export interface SandboxResult {
  reqId: number;
  lines: string[];
  logs: string[];
  ops: JournalEntry[];
  txnId?: string;
  consolePath?: string;
  error?: string;
}
