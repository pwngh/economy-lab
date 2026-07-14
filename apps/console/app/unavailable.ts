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
 * Browser stand-in for the engine's optional DB/cache/queue modules (aliased in vite.config.ts).
 * The tab sandbox never sets the env that selects them, so these can only throw; the alias keeps
 * their node-only drivers out of the bundle entirely.
 */

function unavailable(name: string): never {
  throw new Error(`${name} is not available in the browser sandbox.`);
}

export const postgresStore = () => unavailable('postgresStore');
export const createMysqlPool = () => unavailable('createMysqlPool');
export const mysqlStore = () => unavailable('mysqlStore');
export const readSchemaVersion = () => unavailable('readSchemaVersion');
export const redisCacheFrom = () => unavailable('redisCacheFrom');
export const sqsDispatcher = () => unavailable('sqsDispatcher');

// Also aliased over the bare ioredis and @aws-sdk/client-sqs specifiers src/index.ts
// dynamic-imports directly.
export default class {
  constructor() {
    unavailable('ioredis');
  }
}
export class SQSClient {
  constructor() {
    unavailable('SQSClient');
  }
}
export class SendMessageCommand {
  constructor() {
    unavailable('SendMessageCommand');
  }
}
