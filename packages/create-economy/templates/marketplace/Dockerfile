# Build stage: dev dependencies are needed to compile, and none of them ship.
# The template ships no lockfile — the first local `npm install` writes one — so the copy globs
# it and the install tolerates its absence. When the project has one, the install honours it.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# The lockfile the build stage resolved, so `npm ci` always has one to read.
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

EXPOSE 3000

# node:22-slim carries no curl and no wget, so the probe is node itself. /readyz answers only
# once the store and the worker are up; /healthz answers as soon as the socket binds.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/readyz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exec form, so the command is PID 1 and receives the SIGTERM that drains it.
CMD ["node", "node_modules/.bin/economy", "serve", "--app", "dist/economy.app.js"]
