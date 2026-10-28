# Docker

One container holds the server, the built web app, git (missions are real repositories with per-agent
worktrees) and Chromium for `module_screenshot`. Everything that changes at runtime lives in a volume,
so `docker compose down && up` keeps your workspaces.

```bash
cp .env.example .env             # optional: put your provider keys here
docker compose up -d --build
open http://localhost:8787
```

Without compose:

```bash
docker build -t Outpost .
docker run -d --name Outpost \
  -p 127.0.0.1:8787:8787 -p 127.0.0.1:3100-3199:3100-3199 \
  -v outpost-data:/data -e ANTHROPIC_API_KEY Outpost
```

**Live previews need a published port range.** The App tab points your browser at the app's port, and
the app listens on the container's own loopback, which a published port can't reach. So the shipped
config sets `preview.ports`: Outpost takes a port from that range, listens on it itself and pipes each
connection to the app, WebSockets and HMR included. Publish the same range and previews work from any
browser. The generated app is untouched — it still binds `127.0.0.1:$PORT`. Each running preview holds
one port; narrow the range in **both** `docker/config.json` and `docker-compose.yml` if you'd rather
publish fewer (say `3100-3109`).

**Configuration.** The image sets `OUTPOST_CONFIG=/app/docker/config.json`, which puts `dataDir` in
`/data`, binds `0.0.0.0`, points `render.chromePath` at `/usr/bin/chromium` and reads keys from `$VAR`s.
To use your own: copy that file, edit it, and mount it over `/app/docker/config.json`.

**Data.** The `/data` volume holds the system DB, one SQLite per workspace, mission repos and
worktrees, uploads, `secret.key` and the encrypted model keys. A bind mount works too, but it must be
writable by uid 10001 (`useradd --uid 10001 Outpost` in the image).

**Ports and TLS.** Only 8787 is Outpost; previews use their own range. Outpost speaks plain HTTP (and sends
`x-frame-options: DENY` for itself), so terminate TLS in a reverse proxy in front of it. Reaching Outpost
over HTTPS also means the previews' plain-HTTP ports are blocked as mixed content.

**Git and the shell.** The image has git, bash and node plus a system git identity, so agents can open
worktrees, commit and merge. They run shell commands inside the container, and that shell is
[not sandboxed](limits.md) — the container is the boundary.

**Size.** ~1.8 GB, most of it Chromium. Skip `chromium` from the `apt-get` line and set
`render.enabled: false` in the config if you don't need `module_screenshot`.
