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

// Publishes the prerendered not-found page as the platform 404, run right after `build`. Cloudflare
// Pages serves /404.html for any unmapped path; the prerenderer writes the not-found route to
// 404/index.html. Copying one to the other keeps the cold 404 byte-identical to the app's own —
// full chrome, sidebar, search — instead of a hand-maintained static page that drifts.
import { copyFileSync } from 'node:fs';

copyFileSync('build/client/404/index.html', 'build/client/404.html');
console.log('404.html <- prerendered 404/index.html');
