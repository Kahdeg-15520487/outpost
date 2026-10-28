# Modules

Small apps with a sandboxed client, a sandboxed server and durable storage; the module API is also
the agent's tool surface.

## Module runtime

- **Server:** `server.js` exports a class whose public methods are the RPC API. It runs in its own **QuickJS** VM (`quickjs-wasi`) with a 64 MB heap, a 2 s CPU slice and a 30 s call timeout. It has no fetch, filesystem, timers or Node APIs.
- **`ctx` inside the VM:** `ctx.storage` (sync KV), `ctx.broadcast`, `ctx.caller`, `ctx.presence()`, `ctx.airlocks.<grant>.<method>()`.
- **Serialized, transactional calls:** calls run one at a time. A call's storage writes commit in one pi-durable transaction when it returns. A throwing call rolls back. Broadcasts are released only after the commit (an output gate).
- **Client:** `index.html` runs in `<iframe sandbox="allow-scripts">`, which gives it an opaque origin with no cookies or storage. CSP blocks every network request (`connect-src 'none'`, no external scripts). Its only channel is `postMessage` to the shell, which relays `module.api.method()` calls to the server as the signed-in user.
- **Roles:** viewers can call only the methods listed in `static readonly = [...]`. Editors can call all of them.
- **Visual feedback:** `module_screenshot` renders a module's client in headless Chrome, Chromium or Edge and returns the image to the agent. The render uses the same sandbox as the app and blocks all network access. Alongside the image it reports console output, uncaught errors, failed RPC calls, and any bad selectors in `actions`.
  - `actions` (click, type, press, scroll, hover, wait) exercise the UI before the capture.
  - `width` checks narrow layouts, and `full_page` captures the whole scroll height.
  - Renders run against a **scratch copy** of the module's storage, so clicking through the UI never changes real data. Pass `persist: true` to keep changes.
  - The browser is auto-detected: standard Chrome, Chromium and Edge locations, then the Playwright cache. Override it with `render.chromePath` or `OUTPOST_CHROME`, and disable rendering with `render.enabled: false`. Run `pnpm --filter @outpost/server test:render` to check it.
