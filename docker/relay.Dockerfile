# The enterprise relay alone (T4.10, D81): one bundled file on Node, run as a non-root user. The relay keeps nothing
# but its queue, its admissions and its revocations, all under /data; mount /data read-write and run the root
# filesystem read-only. Build from the repository root: docker build -f docker/relay.Dockerfile -t drop-relay .
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY scripts/bundle.ts ./scripts/bundle.ts
RUN pnpm install --frozen-lockfile
RUN node scripts/bundle.ts --out /out

FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /app
COPY --from=build /out/drop-relay.mjs ./drop-relay.mjs
COPY docker/relay-health.ts ./relay-health.ts
USER node
ENV NODE_ENV=production
EXPOSE 7780 8443
# Liveness from inside the container: plain http, or https on loopback when the relay serves TLS itself.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "relay-health.ts"]
CMD ["node", "drop-relay.mjs", "serve", "--config=/config/relay.config.json"]
