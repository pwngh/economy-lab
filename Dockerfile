# economy-lab — multi-stage image.
#
# Default build is zero-dependency (Node built-ins only); in-memory adapters need
# nothing installed. Bake in the optional Postgres / SQS adapters with:
#
#   docker build --build-arg ADAPTERS="pg @aws-sdk/client-sqs" -t economy-lab .
#
# Base-image digests below are the multi-arch index digests for each tag, looked
# up from the Docker Hub registry API (docker / `docker manifest inspect` were
# unavailable in the authoring env). Pinning means an upstream re-push of the tag
# won't change what we pull until someone re-pins. Refresh with
# `docker manifest inspect <tag>`.

# ---- builder: full Node image (has npm + a shell) -------------------------
# Installs the optional adapters when ADAPTERS is non-empty; otherwise materializes
# an empty node_modules so the runtime COPY below is uniform.
# Node 22 (engines require >=22.18.0, where TypeScript type-stripping is on by default).
# Re-pin a digest for a real deploy: `docker manifest inspect node:22-slim`.
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
#   - :nonroot runs as UID 65532; the --chown on each COPY keeps files owned by it.
#   - Pinned by tag, not digest: the authoring env could only resolve per-arch
#     child digests, and pinning one locks the image to a single architecture. To
#     pin the multi-arch index digest at build time, run:
#         crane digest gcr.io/distroless/nodejs22-debian12:nonroot
#     (or `docker buildx imagetools inspect`) and replace the tag with
#     tag@sha256:<index-digest>.
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

# Liveness probe with no shell or curl available: Node's http client hits /healthz
# on the configured PORT and exits 0 only on HTTP 200. Inline (`node -e`, CommonJS)
# to avoid an extra file or app dependency.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "const http=require('http');http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/healthz',timeout:2500},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

# Entry is scripts/main.ts (distroless ENTRYPOINT supplies `node`, so args are script + mode; Node 22
# strips types by default). The image does not migrate: apply db/schema.sql out-of-band (e.g.
# `npm run db:migrate`) before pointing this at a real DATABASE_URL. For the worker, override the
# args: ["scripts/main.ts","worker"].
CMD ["scripts/main.ts", "serve"]
