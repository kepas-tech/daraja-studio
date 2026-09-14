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

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
RUN addgroup -S studio && adduser -S studio -G studio
WORKDIR /app
COPY --from=build /out/server ./server
COPY --from=build /app/web/dist ./web/dist
USER studio
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/dist/index.js"]
