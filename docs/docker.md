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

**Ports and TLS.** Only 8787 is Outpost; previews either use their own range or a hostname. Outpost speaks
plain HTTP (and sends `x-frame-options: DENY` for itself), so terminate TLS in a reverse proxy in front of
it. Reaching Outpost over HTTPS also means the previews' plain-HTTP ports are blocked as mixed content.

**Previews over HTTPS: `preview.baseDomain`.** Set it (or `OUTPOST_PREVIEW_BASE_DOMAIN`) to a domain whose
wildcard your certificate already covers, and previews move onto Outpost's own port, dispatched by Host
header: `https://<slug>.<baseDomain>/` → the reverse proxy → `outpost:8787` → the app's loopback port. No
port range to publish, one router, and HMR works because the WebSocket upgrade is proxied too.

```json
{ "preview": { "baseDomain": "os.example.net" } }
```

Then teach the reverse proxy one wildcard route:

- `HostRegexp(`^[a-z0-9-]{1,63}\.os\.example\.net$`)` → `outpost:8787` (TLS terminator serving
  `*.os.example.net`). `<slug>` is the mission's name plus a short hash, fixed when the mission is created.
- Keep `preview.ports` unset so nothing starts a public listener; the proxy targets the dev server's own
  loopback port.
- **One label deep.** `<slug>.os.example.net` needs a certificate for `*.os.example.net`. A public CA will
  not issue two wildcard levels for free, so if your certificate only covers `*.example.net`, use
  `"baseDomain": "example.net"` and previews become `<slug>.example.net`.
- The URL is not public: the proxy only forwards when the viewer's session cookie belongs to a member of
  the mission's workspace (403 otherwise), which means the cookie has to be scoped to the base domain —
  Outpost does that itself when `preview.baseDomain` is set and the request arrives on that domain.
- Apps that redirect with an absolute `http://localhost:PORT/…` are rewritten back onto the public host;
  relative redirects (`Location: /login`) need nothing.

**Git and the shell.** The image has git, bash and node plus a system git identity, so agents can open
worktrees, commit and merge. They run shell commands inside the container, and that shell is
[not sandboxed](limits.md) — the container is the boundary.

**Size.** ~1.8 GB, most of it Chromium. Skip `chromium` from the `apt-get` line and set
`render.enabled: false` in the config if you don't need `module_screenshot`.
