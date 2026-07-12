# economy-lab — multi-stage image. The default build is zero-dependency; bake in optional
# drivers with: docker build --build-arg ADAPTERS="pg @aws-sdk/client-sqs" -t economy-lab .
#
# Base images are pinned by tag only. For a real deploy, replace each tag with
# tag@sha256:<multi-arch index digest> (`docker manifest inspect <tag>`) so an upstream
# re-push cannot change what is pulled.

# ---- builder ---------------------------------------------------------------
# With ADAPTERS empty, materialize an empty node_modules so the runtime COPY below is uniform.
# Node >=22.18 required: the version where TypeScript type-stripping is on by default.
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

# Liveness probe. Distroless has no shell or curl, so an inline `node -e` (CommonJS) hits
# /healthz and exits 0 only on HTTP 200.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "const http=require('http');http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/healthz',timeout:2500},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

# The image never runs migrations: apply the schema in db/ out of band (e.g. `make db-migrate`)
# before pointing this at a real DATABASE_URL. To run the worker instead, override the args:
# ["scripts/main.ts","worker"].
CMD ["scripts/main.ts", "serve"]
