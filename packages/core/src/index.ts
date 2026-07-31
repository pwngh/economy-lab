/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// The operations vocabulary is `./ops`, the loading contract `./module`, the authenticate
// posture `@pwngh/economy-auth`, and amounts `@pwngh/economy-money`.
export { createApp } from './app.js';
export type { App, CreateAppOptions, Knob, KnobKey } from './app.js';
export type {
  CatalogExport,
  EconomyModule,
  OperationDraft,
  PortsOverrides,
  ResolvedModule,
  WorkerExport,
  RouteHandler,
  RouteKey,
} from './module.js';
export { withDev } from './dev.js';
export type { Capabilities, InspectReport } from './inspect.js';
export type { Principal } from '@pwngh/economy-lab';
// Never re-exported: boot, openPorts, memoryPorts, createEconomy, createServer, createWorker,
// handleWebhook. Reaching one is the escape hatch — import it from @pwngh/economy-lab instead.
