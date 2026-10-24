# syntax=docker/dockerfile:1
#
# pi-os in one container: the server, the built web app, git (projects live in real repositories and
# per-agent worktrees), and Chromium for gadget_screenshot. Nothing that changes at runtime is in the
# image — workspaces, projects, uploads, the secret and stored keys all live in /data.
#
# Live previews are the one thing that isn't loopback-friendly: the App tab points a browser at a
# port, so pi-os publishes a range and forwards to each app's loopback port (preview.ports in
# docker/config.json). See the README's Docker section.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Same pnpm the CI uses (the lockfile is v9, so pnpm 10 reads it).
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Dependencies first: this layer only moves when a manifest or the lockfile does.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

# The server runs from TypeScript through tsx, so only the web app is compiled.
FROM deps AS build
COPY . .
RUN pnpm --filter @pi-os/web build

FROM base AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git bash tini chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 # Agents commit and merge in project repos; keep a system identity so plain `git commit` works too.
 && git config --system user.name "pi-os agent" \
 && git config --system user.email "agent@pi-os.local" \
 && useradd --create-home --uid 10001 pi-os \
 && mkdir -p /data && chown pi-os:pi-os /data

COPY --from=build --chown=pi-os:pi-os /app /app

ENV NODE_ENV=production \
    PI_OS_CONFIG=/app/docker/config.json \
    PI_OS_DATA=/data \
    PI_OS_CHROME=/usr/bin/chromium

USER pi-os
WORKDIR /app
EXPOSE 8787
# preview.ports in docker/config.json (publish the same range with -p/ports: in compose).
EXPOSE 3100-3199

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/me').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# tini reaps the dev servers and agents the server spawns.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/node_modules/tsx/dist/cli.mjs", "packages/server/src/main.ts"]
