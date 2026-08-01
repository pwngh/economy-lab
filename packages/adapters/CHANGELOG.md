# Changelog

Notable changes to `@pwngh/economy-adapters`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- The framework mounts for an `App`. There is no root export — one subpath per framework, and the `exports` map in `package.json` is the list.
- `economyExpress(app)` is Express or Connect middleware. Mount it before a body parser, or give it `express.raw` scoped to the economy's paths — a consumed stream cannot verify a webhook signature.
- The Express mount answers the paths the app declares (`App.capabilities().routes`) and calls `next()` for every other path without reading the request; a rejection inside it goes to `next(error)`.
- `economyFastify(app)` is a plugin registered with `fastify.register`; inside its own encapsulation every content type parses to a raw buffer.
- Both mounts send a null-body response as one, and neither sets a content type the economy did not set.
- A mount given an `App` starts its background half and returns the mount carrying a `close()`. Given a bare handler it returns the mount alone: the caller kept the app and its lifecycle.
- `{ worker: false }` binds the face and starts nothing, for a deployment whose worker role runs in another process.
- A value that is neither an app nor a handler is refused at mount, naming `createApp`.
- The mounts are transport only and the package declares no framework dependency.
- `demos/bun`, `demos/cloudflare`, `demos/hono` and `demos/next` mount `app.handler` on the runtimes that take a Fetch `Request` as it is.
