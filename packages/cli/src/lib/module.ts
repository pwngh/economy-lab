/**
 * @pwngh/economy-cli
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { existsSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  resolveEconomyModule,
  EconomyModuleError,
  MODULE_ERROR_CODES,
  stripInterop,
} from '@pwngh/economy-core/module';
import type { ResolvedModule } from '@pwngh/economy-core/module';

const EXTS = ['.ts', '.mts', '.mjs', '.js'];
const VERBS = ['get', 'post', 'put', 'delete'];

export interface LoadDirOptions {
  /** Cache-buster for re-imports in watch mode. */
  readonly generation?: number;
  /** The dynamic importer; the bin injects one that re-execs when TS needs stripping. */
  readonly importer?: (url: string) => Promise<Record<string, unknown>>;
  /** How errors name the module; defaults to `dir`. */
  readonly label?: string;
}

/** Resolves `app.ts` plus `routes/**` as one module. Filename is the path, export name is
 *  the role; anything without an address refuses. */
export async function loadEconomyDir(
  dir: string,
  options: LoadDirOptions = {},
): Promise<ResolvedModule> {
  const label = options.label ?? dir;
  const importer = options.importer ?? ((url: string) => import(url));
  // stripInterop owns the read: it copies defensively, so a hostile namespace (a getter
  // that throws, Symbol keys) refuses by name instead of faulting in a spread here.
  const load = async (file: string): Promise<Record<string, unknown>> =>
    stripInterop(
      await importer(
        `${pathToFileURL(file).href}?v=${options.generation ?? 0}`,
      ),
      label,
    );
  const refuse = (exp: string, fix: string): never => {
    throw new EconomyModuleError(
      MODULE_ERROR_CODES.SEAM_SHAPE,
      label,
      exp,
      fix,
    );
  };

  const appFile = EXTS.map((e) => join(dir, `app${e}`)).find(existsSync);
  if (!appFile) {
    throw new EconomyModuleError(
      MODULE_ERROR_CODES.NOT_FOUND,
      label,
      'app.ts',
      'the directory form needs an app.ts root module — same contract as the single file',
    );
  }
  if (existsSync(join(dir, 'after'))) {
    refuse(
      'after',
      '`after/` has no address — after is an export of app.ts; move the handlers there',
    );
  }
  if (existsSync(join(dir, 'webhooks'))) {
    refuse(
      'webhooks',
      'a top-level `webhooks/` has no address — the decoders live at routes/webhooks/; move the directory there',
    );
  }

  const routes: Record<string, unknown> = {};
  const providers: Record<string, unknown> = {};
  // Which file filled each key. Two files resolving to one address is ambiguous, and this is
  // what lets the second one name the first.
  const owner = new Map<string, string>();
  const claim = (key: string, file: string, exp: string): void => {
    const held = owner.get(key);
    if (held !== undefined) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.ROLE_CONFLICT,
        label,
        exp,
        `${relative(dir, held)} and ${relative(dir, file)} both address it — one owner: rename or delete one`,
      );
    }
    owner.set(key, file);
  };
  // Dotfiles (.DS_Store, .gitkeep) are not module files — skipped, never refused.
  const listing = (d: string) =>
    readdirSync(d, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

  const scanRoutes = async (d: string, prefix: string): Promise<void> => {
    const entries = listing(d);
    // An `index` file addresses its containing path — `routes/index.ts` mounts `/` and
    // `routes/shop/index.ts` mounts `/shop` — the addresses the single-file form can already
    // declare. Errors keep naming the file, so a fault in shop/index.ts says so.
    const mountOf = (stem: string): string =>
      stem === 'index' ? prefix || '/' : `${prefix}/${stem}`;
    // Addresses first, imports second. Importing is what runs a file, so an ambiguous tree has
    // to refuse before any of it executes: `.ts` sorts after `.js`, and the losing half of a
    // same-stem pair used to run for its side effects and then have its handler dropped. A
    // directory sorts before its same-stem file, so a shop.ts against shop/index.ts collision
    // is also found before either half loads.
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const ext = extname(entry.name);
      if (!EXTS.includes(ext)) {
        refuse(
          `routes${prefix}/${entry.name}`,
          'only route modules live under routes/ — move this file out',
        );
      }
      const mount = mountOf(entry.name.slice(0, -ext.length));
      claim(`route ${mount}`, join(d, entry.name), `routes${mount}`);
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (prefix === '' && entry.name === 'webhooks')
          await scanWebhooks(full);
        else await scanRoutes(full, `${prefix}/${entry.name}`);
        continue;
      }
      const ext = extname(entry.name);
      const stem = entry.name.slice(0, -ext.length);
      const path = `${prefix}/${stem}`;
      const exports = Object.entries(await load(full)).filter(
        ([, v]) => v !== undefined,
      );
      if (!exports.length)
        refuse(
          `routes${path}`,
          'a route file exports get, post, put, or delete',
        );
      for (const [name, value] of exports) {
        if (!VERBS.includes(name)) {
          throw new EconomyModuleError(
            MODULE_ERROR_CODES.UNKNOWN_EXPORT,
            label,
            `routes${path}#${name}`,
            'a route file exports get, post, put, or delete — anything else has no address here',
          );
        }
        if (typeof value !== 'function')
          refuse(
            `routes${path}#${name}`,
            'a route export is a handler function',
          );
        routes[`${name.toUpperCase()} ${mountOf(stem)}`] = value;
      }
    }
  };
  const scanWebhooks = async (d: string): Promise<void> => {
    const entries = listing(d);
    for (const entry of entries) {
      const ext = extname(entry.name);
      if (entry.isDirectory() || !EXTS.includes(ext)) {
        refuse(
          `routes/webhooks/${entry.name}`,
          'webhooks/ holds one decoder file per provider',
        );
      }
      const provider = entry.name.slice(0, -ext.length);
      claim(
        `webhook ${provider}`,
        join(d, entry.name),
        `routes/webhooks/${provider}`,
      );
    }
    for (const entry of entries) {
      const provider = entry.name.slice(0, -extname(entry.name).length);
      const exports = Object.entries(await load(join(d, entry.name))).filter(
        ([, v]) => v !== undefined,
      );
      for (const [name, value] of exports) {
        // Two different faults: a name this file has no address for, and the right name with
        // the wrong shape — the same split the route walk above makes.
        if (name !== 'decode') {
          throw new EconomyModuleError(
            MODULE_ERROR_CODES.UNKNOWN_EXPORT,
            label,
            `routes/webhooks/${provider}#${name}`,
            'a webhook file exports one `decode(raw)` function; the filename is the provider name',
          );
        }
        if (typeof value !== 'function')
          refuse(
            `routes/webhooks/${provider}#decode`,
            'a webhook `decode` export is the decoder function `decode(raw)`',
          );
        providers[provider] = value;
      }
      // This file's own contribution, not the accumulated map: an empty second file used to
      // pass because an earlier one had already filled the key.
      if (!exports.length) {
        refuse(
          `routes/webhooks/${provider}`,
          'a webhook file exports one `decode(raw)` function',
        );
      }
    }
  };
  if (existsSync(join(dir, 'routes')))
    await scanRoutes(join(dir, 'routes'), '');

  const merged = { ...(await load(appFile)) };
  if (Object.keys(routes).length) {
    if (merged.routes !== undefined) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.ROLE_CONFLICT,
        label,
        'routes',
        'app.ts exports `routes` while routes/ files exist — one owner: keep the files or the export',
      );
    }
    merged.routes = routes;
  }
  if (Object.keys(providers).length) {
    if (merged.providers !== undefined) {
      throw new EconomyModuleError(
        MODULE_ERROR_CODES.ROLE_CONFLICT,
        label,
        'providers',
        'app.ts exports `providers` while routes/webhooks/ files exist — one owner: keep the files or the export',
      );
    }
    merged.providers = providers;
  }
  // Keys sort like an ESM namespace's, so the directory and the equivalent single file
  // resolve byte-identically, `exports` order included.
  return resolveEconomyModule(
    Object.fromEntries(
      Object.keys(merged)
        .sort()
        .map((k) => [k, merged[k]]),
    ),
    label,
  );
}
