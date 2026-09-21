FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
# argon2 has no prebuilt binary for this platform and compiles from source
# (see root package.json's pnpm.onlyBuiltDependencies) — needs a toolchain.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY . .
RUN pnpm -r build
# Produces a self-contained node_modules (workspace deps resolved, dev deps
# stripped) for the server package only — avoids copying the whole pnpm
# workspace's symlink layout into the runtime image.
RUN pnpm --filter @daraja-studio/server deploy --prod --legacy /out/server

# The private half of the product — the accounts service — lives in its own repository, and the
# image builds it here, at one pinned commit, so an image is a named package rather than whatever
# `main` happened to be that morning. That repository is private, so the clone needs a key — an SSH
# key on the account that owns it, made for this build and kept on the server, because GitHub has
# deploy keys turned off for the organisation that owns the repository. The key is the part that has
# to be handled carefully: it arrives as a BuildKit secret, which
# keeps it out of an image layer, out of the build context, out of `docker history` and out of a
# log, and the clone is the only command that may read it. The secret is declared `required=false`:
# a build with no key at all still makes a studio, one with no package in it, which boots and
# serves exactly as it did before the seam existed.
FROM base AS host
ARG STUDIO_HOST_REPO=git@github.com:kepas-tech/studio-host.git
ARG STUDIO_HOST_COMMIT=1d8f6d628f1de0807de758c0f85cda3ab8412440
RUN apk add --no-cache git openssh-client
RUN --mount=type=secret,id=studio_host_key,required=false \
    set -eu; \
    rm -rf /host; \
    if [ -s /run/secrets/studio_host_key ]; then \
      mkdir -p /root/.ssh; \
      cp /run/secrets/studio_host_key /tmp/studio_host_key; \
      chmod 600 /tmp/studio_host_key; \
      GIT_SSH_COMMAND="ssh -i /tmp/studio_host_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
        git clone --quiet "$STUDIO_HOST_REPO" /host; \
      rm -f /tmp/studio_host_key; \
      git -C /host checkout --quiet "$STUDIO_HOST_COMMIT"; \
      echo "studio-host: built $STUDIO_HOST_COMMIT"; \
      cd /host && pnpm install --frozen-lockfile && pnpm build; \
    else \
      mkdir -p /host/dist /host/migrations; \
      echo "studio-host: no key was given, so this image has no package in it"; \
    fi

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# Where the core resolves the package by name, and where its migrations are read from: the same
# directory. A build with no key leaves that directory there and empty, which is the honest shape of
# it — a package that cannot be resolved is silence at boot, and an empty migrations directory is no
# migrations.
ENV STUDIO_EXTENSION_MIGRATIONS=/app/server/node_modules/@kepas/studio-host/migrations
RUN addgroup -S studio && adduser -S studio -G studio
WORKDIR /app
COPY --from=build /out/server ./server
COPY --from=build /app/web/dist ./web/dist
# The package itself, when the build had a key for it: the built code, its migrations and its
# manifest, which is everything the core resolves and reads.
RUN --mount=type=bind,from=host,source=/host,target=/pkg \
    mkdir -p server/node_modules/@kepas/studio-host; \
    cp -r /pkg/dist /pkg/migrations server/node_modules/@kepas/studio-host/; \
    if [ -f /pkg/package.json ]; then cp /pkg/package.json server/node_modules/@kepas/studio-host/; fi
USER studio
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/dist/index.js"]
