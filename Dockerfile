# economy-lab — multi-stage image.
#
# Default build is zero-dependency (Node built-ins only); in-memory adapters need
# nothing installed. Bake in the optional Postgres / SQS adapters with:
#
#   docker build --build-arg ADAPTERS="pg @aws-sdk/client-sqs" -t economy-lab .
#
# Base images are pinned by tag, not digest. For a real deploy, pin each tag to its
# multi-arch index digest: `docker manifest inspect <tag>` (or `crane digest <tag>`)
# and replace the tag with tag@sha256:<index-digest>, so an upstream re-push of the
# tag cannot change what is pulled.

# ---- builder: full Node image (has npm + a shell) -------------------------
# Installs the optional adapters when ADAPTERS is non-empty; otherwise materializes
# an empty node_modules so the runtime COPY below is uniform.
# Node 22 is required. The engines field requires >=22.18.0, the version where
# TypeScript type-stripping is on by default.
FROM node:22-slim AS builder

WORKDIR /app
COPY package.json ./

ARG ADAPTERS=""
RUN if [ -n "$ADAPTERS" ]; then \
        npm install --no-save --no-audit --no-fund $ADAPTERS; \
    else \
        mkdir -p node_modules; \
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
COPY --chown=nonroot:nonroot src ./src
COPY --chown=nonroot:nonroot scripts ./scripts
COPY --chown=nonroot:nonroot db ./db

EXPOSE 3000

# Liveness probe. The distroless image has no shell and no curl, so Node's http
# client hits /healthz on the configured PORT and exits 0 only on HTTP 200. The
# check runs inline (`node -e`, CommonJS) to avoid an extra file or app dependency.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "const http=require('http');http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/healthz',timeout:2500},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

# The entry point is scripts/main.ts. The distroless ENTRYPOINT supplies `node`, so the args are just
# the script path and the mode, and Node 22 strips the types at startup. The image does not run
# migrations, so apply the schema in db/ out of band (for example, `make db-migrate`) before
# pointing this at a real DATABASE_URL. To run the worker instead, override the args:
# ["scripts/main.ts","worker"].
CMD ["scripts/main.ts", "serve"]
