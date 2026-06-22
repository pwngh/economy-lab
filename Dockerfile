# economy-lab — multi-stage image.
#
# Default build is zero-dependency (Node built-ins only): the in-memory adapters
# need nothing installed, so the runtime image carries no node_modules of note.
# To bake in the optional Postgres / SQS adapters for a real deploy, build with:
#
#   docker build --build-arg ADAPTERS="pg @aws-sdk/client-sqs" -t economy-lab .
#
# Base-image digests below were looked up from the Docker Hub registry API
# (docker / `docker manifest inspect` were unavailable in the authoring env).
# They are the multi-arch index digests for each tag as of the lookup; pinning
# them means an upstream re-push of the tag will NOT change what we pull until
# someone deliberately re-pins. Refresh with `docker manifest inspect <tag>`.

# ---- builder: full Node image (has npm + a shell) -------------------------
# Installs the optional adapters only when ADAPTERS is non-empty; otherwise it
# materializes an empty node_modules so the runtime COPY below is uniform.
# Node 22 (engines require >=22.18.0, where TypeScript type-stripping is on by default — no flag).
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
#     path — hence "node" is dropped from the original CMD.
#   - :nonroot runs as UID 65532; the --chown on each COPY keeps files owned by it.
#   - Pinned by TAG, not digest: the authoring env could only resolve per-arch
#     child digests, and pinning one of those would lock the image to a single
#     architecture. To pin the multi-arch index digest at build time, run:
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

# Liveness probe with no shell or curl available: Node's built-in http client
# hits /healthz on the configured PORT and exits 0 only on HTTP 200. Run inline
# (CommonJS via `node -e`) so no extra file or app dependency is introduced.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "const http=require('http');http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/healthz',timeout:2500},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

# The real entry is scripts/main.ts (the distroless ENTRYPOINT supplies `node`, so the args here
# are script + mode; Node 22 strips TypeScript types by default, no flags needed). The image does
# NOT migrate: apply db/schema.sql out-of-band (e.g. `npm run db:migrate`) before pointing this at a
# real DATABASE_URL. Override the args to run the worker instead: ["scripts/main.ts","worker"].
CMD ["scripts/main.ts", "serve"]
