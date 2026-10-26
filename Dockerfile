# One image for the lab services: drop-relay, drop-node, drop-gateway and the site (different command). No build step: Node strips types.
FROM node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
# Workspace symlinks must stay: Node refuses to strip types for .ts files under node_modules, and the symlinks
# resolve to /app/packages/*/src.
RUN pnpm install --frozen-lockfile --prod
COPY docker ./docker
RUN chmod 0755 docker/*.sh
# The public site (T2.6): `node scripts/site.ts serve` renders it in memory from these sources, nothing is built here.
COPY site ./site
COPY scripts/site.ts scripts/mac-updates.ts ./scripts/
COPY docs ./docs
USER node
ENV NODE_ENV=production
# The commit this image was built from (D91): the relay reports it on /health so a deployment is verifiable without
# server access. CI passes the SHA; a build that does not leaves the relay answering "unknown".
ARG DROP_BUILD=unknown
ENV DROP_BUILD=$DROP_BUILD
CMD ["node", "packages/relay/src/cli.ts", "serve", "--config=/config/relay.config.json"]
