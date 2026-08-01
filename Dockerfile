# economy-lab — the repository's own economy, run the way a customer runs theirs: the `economy`
# bin over the module in economy/. Bake in optional drivers with:
#   docker build --build-arg ADAPTERS="pg @aws-sdk/client-sqs" -t economy-lab .
#
# The image carries the built emit rather than building it: dist/ and packages/*/dist are what
# `npm run build` and `npm run build:packages` write, and check.ts refuses a stale one before this
# image is ever built. Lab TypeScript under src/ is still type-stripped by node at load.
#
# Base images are pinned by tag only. For a real deploy, replace each tag with
# tag@sha256:<multi-arch index digest> (`docker manifest inspect <tag>`) so an upstream
# re-push cannot change what is pulled.

# ---- builder: the module graph, and nothing else ---------------------------
# node_modules is where the workspace links live — @pwngh/economy-* point at packages/*, and
# @pwngh/economy-lab points at the image root — so the runtime stage below resolves the same
# specifiers a checkout does. Node >=22.18 required: type-stripping is on by default there.
FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages

ARG ADAPTERS=""
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && if [ -n "$ADAPTERS" ]; then \
        npm install --no-save --no-audit --no-fund $ADAPTERS; \
    fi

# ---- runtime: distroless (no shell, no package manager, nonroot) ----------
# gcr.io/distroless/nodejs22-debian12:nonroot
#   - ENTRYPOINT is already ["/nodejs/bin/node"], so CMD carries only the script
#     path ("node" dropped from the original CMD).
#   - :nonroot runs as UID 65532. The --chown on each COPY below keeps the copied
#     files owned by that UID.
#   - Pin per the header note; a per-arch child digest would lock the image to a
#     single architecture, so use the multi-arch index digest.
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --chown=nonroot:nonroot package.json ./
COPY --chown=nonroot:nonroot packages ./packages
COPY --chown=nonroot:nonroot dist ./dist
COPY --chown=nonroot:nonroot src ./src
COPY --chown=nonroot:nonroot economy ./economy

EXPOSE 3000

# Liveness probe. Distroless has no shell or curl, so an inline `node -e` (CommonJS) hits
# /healthz and exits 0 only on HTTP 200.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "const http=require('http');http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/healthz',timeout:2500},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

# The image never runs migrations: apply the schema each engine package ships (packages/*/db)
# out of band before pointing this at a real DATABASE_URL. `economy serve` is the production
# posture and refuses every dev stand-in before it binds. To run the worker role instead,
# override the args: ["node_modules/@pwngh/economy/dist/cli-entry.js","worker"].
CMD ["node_modules/@pwngh/economy/dist/cli-entry.js", "serve"]
