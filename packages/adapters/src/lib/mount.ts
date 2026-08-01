/**
 * @pwngh/economy-adapters
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import type { App } from '@pwngh/economy-core';

export type FetchLike = (request: Request) => Promise<Response>;
export type Mountable = App | FetchLike;

export interface MountOptions {
  /** The split-process deployment: the worker role runs in another process, so this mount
   *  binds the face and starts nothing. Default true. */
  readonly worker?: boolean;
}

/** A mount over an app: the framework's own shape, carrying the lifecycle behind it. */
export type Mounted<Shape> = Shape & { close(): Promise<void> };

export interface Mount {
  readonly handler: FetchLike;
  /** Whether this mount answers the path. A bare handler declares no table and so answers
   *  every path — the caller kept the app, and mounts it where it belongs. */
  readonly claims: (pathname: string) => boolean;
  /** Present only for an app: a bare handler has no lifecycle to end. */
  readonly close?: () => Promise<void>;
}

const isApp = (app: Mountable): app is App =>
  typeof (app as App).startWorker === 'function';

/**
 * Path ownership read off the app's own declared routes, so it cannot drift from what the
 * server answers. Ownership is by path, never by method: a declared path keeps its own 405s
 * and its own CORS preflight instead of handing them to a host that never mounted it.
 */
function claimsOf(app: App): (pathname: string) => boolean {
  const declared = app
    .capabilities()
    .routes.map((route) => route.path.split('/').filter(Boolean));
  return (pathname) => {
    const asked = pathname.split('/').filter(Boolean);
    return declared.some(
      (route) =>
        route.length === asked.length &&
        route.every(
          (segment, i) => segment.startsWith(':') || segment === asked[i],
        ),
    );
  };
}

/**
 * Resolves the fetch handler once at mount, so a missing auth posture fails there rather than
 * on the first request, and starts the background half when the caller handed over a whole
 * app. Mounting the face alone leaves every sweep stopped: payouts never settle, the outbox
 * never relays, and nothing says so. A bare handler is mounted as given — the caller kept the
 * app, so the lifecycle is theirs.
 */
export function openMount(app: Mountable, options: MountOptions = {}): Mount {
  if (typeof app === 'function') return { handler: app, claims: () => true };
  if (!isApp(app)) {
    throw new TypeError(
      'mount takes an App or a (request) => Promise<Response> handler. A module definition ' +
        'is neither until createApp() resolves it into one.',
    );
  }
  const handler: FetchLike = app.handler;
  if (options.worker !== false) app.startWorker();
  return { handler, claims: claimsOf(app), close: () => app.close() };
}

/** Hands the framework shape back with the lifecycle attached, and only when it owns one. */
export function mounted<Shape extends object>(
  shape: Shape,
  mount: Mount,
): Shape | Mounted<Shape> {
  return mount.close ? Object.assign(shape, { close: mount.close }) : shape;
}
