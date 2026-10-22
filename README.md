# pi·os

An AI workspace in the spirit of [Cloudflare OS](https://github.com/cloudflare/cloudflare-os), self-hosted on Node, with [**pi-durable**](https://github.com/earendil-works/pi/tree/main/packages/durable) as the kernel.

- **Agents that survive crashes.** Every chat is a pi-durable conversation. Model turns, tool calls and app state are committed to SQLite before they are shown. Kill the process mid-run and the run resumes from its last checkpoint on restart.
- **Gadgets.** Small private apps the agent writes for you. Each gadget has a sandboxed client and a sandboxed server with durable storage. Gadgets are multiplayer by default, and their API doubles as the agent's tool surface.
- **Gatekeepers.** Agents and gadgets get access through capabilities rather than ambient access. Each resource is introduced explicitly. Side effects are simulated and queued, so work continues and you approve in bulk later.
- **Blueprints, sharing, and live multiplayer.** Share a gadget instance with people or a link (viewer or editor), or publish its code so others get their own copy.

```
 Normal OS      pi-os                                        where
 ─────────────  ───────────────────────────────────────────  ─────────────────────────────
 kernel         pi-durable Harness, one SQLite per workspace  server/src/kernel/workspace.ts
 processes      gadgets: QuickJS server + sandboxed iframe    server/src/gadgets/
 drivers        gatekeepers: web, github, mailbox             server/src/gatekeepers/
 executables    blueprints                                    server/blueprints/
 shell          React app                                     web/
 users / ACLs   system SQLite: users, members, shares, links  server/src/kernel/system-db.ts
```

## Run

Requires Node ≥ 22.13 (uses built-in `node:sqlite`) and pnpm.

```bash
pnpm install
pnpm start            # builds the web app, serves everything on http://127.0.0.1:8787
```

Development, with hot reload for both server and web:

```bash
pnpm dev              # server on :8787 (tsx watch), web on http://localhost:5173 (proxies /api, /ws, /frame)
```

Sign up. The first account gets a personal workspace. Invite others by username in **Settings → Members**, or share single gadgets.

### Models

pi-os uses every provider pi supports: Anthropic, OpenAI, Google, Azure, Bedrock, GitHub Copilot, OpenRouter, Groq, Mistral, DeepSeek, and more. Credentials resolve the way pi resolves them:

1. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …).
2. `~/.pi/agent/auth.json`, shared with the pi CLI. Anything you `pi /login` into works here, including OAuth subscriptions.
3. **Settings → Model providers → Add key**, which writes to that same file.

The default model for new chats is your pi default (`~/.pi/agent/settings.json`), otherwise the first available model. You can override it per workspace or per chat. With no credentials at all, there's an offline **Demo** model that follows a few scripts ("make a todo list", "make slides", …).

### Environment

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | |
| `PI_OS_DATA` | `./data` | system DB, one `workspaces/<id>.sqlite` per workspace, signing key |
| `PI_OS_AUTH_FILE` | `~/.pi/agent/auth.json` if present, else `data/auth.json` | model credentials |
| `GITHUB_TOKEN` | – | used by the GitHub Gatekeeper (private repos, writes, rate limits) |

## How it maps onto pi-durable

| Concept | pi-durable primitive |
|---|---|
| Workspace | one `Harness` over `openNodeSqliteStorage(data/workspaces/<id>.sqlite)` |
| Chat | an ownerless `Conversation`. Messages are submitted with an `os.user` entry carrying the author. Steering and follow-ups use `whenBusy` |
| Live transcript | `watchEvents()` streamed over WebSocket to every member watching |
| Agent tools | one `os` extension (gadget, blueprint, Gatekeeper and subagent tools, plus prompt sections), along with `createCodemodeExtension` |
| Subagents | a task-owned child conversation (`ownership: { kind: "task" }`), `replay: "safe"` |
| Gadget code / storage / logs | session document families `os.gadget.source` / `.state` / `.logs` |
| Grants, access requests, approvals, audit | session documents `os.grants`, `os.approvals`, `os.audit` |
| Telling the agent that something happened (grant, approval) | a `write` submission whose entry carries a model-visible message, placed at the next turn boundary |
| Crash recovery | `harness.resume()` on start. Every workspace is reopened at boot |

### Gadget runtime

- **Server:** `server.js` exports a class whose public methods are the RPC API. It runs in its own **QuickJS** VM (`quickjs-wasi`) with a 64 MB heap, a 2 s CPU slice and a 30 s call timeout. It has no fetch, filesystem, timers or Node APIs.
- **`ctx` inside the VM:** `ctx.storage` (sync KV), `ctx.broadcast`, `ctx.caller`, `ctx.presence()`, `ctx.gatekeepers.<grant>.<method>()`.
- **Durable Object-like semantics:** calls are serialized. A call's storage writes commit in one pi-durable transaction when it returns. A throwing call rolls back. Broadcasts are released only after the commit (an output gate).
- **Client:** `index.html` runs in `<iframe sandbox="allow-scripts">`, which gives it an opaque origin with no cookies or storage. CSP blocks every network request (`connect-src 'none'`, no external scripts). Its only channel is `postMessage` to the shell, which relays `gadget.api.method()` calls to the server as the signed-in user.
- **Roles:** viewers can call only the methods listed in `static readonly = [...]`. Editors can call all of them.

### Gatekeepers

Every Gatekeeper exposes a typed API scoped to one resource. Each method is either `read` or `write`.

- Grants are held by a **chat** or a **gadget** (`holder`). Nothing is ambient: a gadget can't use its chat's grants, and vice versa.
- **Reads** run right away. Pending writes are **overlaid** on later reads, so a queued "create issue" appears in `list_issues`.
- **Writes** return a simulated result immediately and add an action to the approval queue. Approving runs the real call. The outcome is reported back to the chat that asked. Grants can opt into auto-approve.
- Every call is written to the audit log.

Built in:

- `web`: one HTTP origin.
- `github`: one repository: issues, files, comments.
- `mailbox`: a local outbox for trying approvals with no external account.

To add one, put a definition in `server/src/gatekeepers/catalog.ts`.

## Test

```bash
PORT=8799 PI_OS_DATA=/tmp/pios pnpm --filter @pi-os/server start &
pnpm smoke            # auth, chat→gadget via the demo model, RPC, rollback, CSP, sharing/roles/presence,
                      # gatekeeper capability checks, deferred approval, overlay, blueprints
```

## Not (yet) like Cloudflare OS

- Gadget servers are QuickJS VMs in the main process, not Dynamic Worker facets. They have no outbound network and no timers or alarms.
- Gatekeepers run in-process and use a static token (`GITHUB_TOKEN`) instead of per-user OAuth.
- Realtime collaboration is method calls plus broadcasts, not CRDT/OT text editing.
- Single process: storage has one owner, so there's no horizontal scaling.
