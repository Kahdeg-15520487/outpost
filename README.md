# Outpost

A self-hosted AI workspace on Node, with [**pi-durable**](https://github.com/earendil-works/pi/tree/main/packages/durable) as the kernel.

- **Agents that survive crashes.** Every chat is a pi-durable conversation. Model turns, tool calls and app state are committed to SQLite before they are shown. Kill the process mid-run and the run resumes from its last checkpoint on restart.
- **Modules.** Small private apps the agent writes for you. Each module has a sandboxed client and a sandboxed server with durable storage. Modules are multiplayer by default, and their API doubles as the agent's tool surface.
- **Airlocks.** Agents and modules get access through capabilities rather than ambient access. Each resource is introduced explicitly. Side effects are simulated and queued, so work continues and you approve in bulk later.
- **Blueprints, sharing, and live multiplayer.** Share a module instance with people or a link (viewer or editor), or publish its code so others get their own copy.

```
 Normal OS      Outpost                                        where
 ─────────────  ───────────────────────────────────────────  ─────────────────────────────
 kernel         pi-durable Harness, one SQLite per workspace  server/src/kernel/workspace.ts
 processes      modules: QuickJS server + sandboxed iframe    server/src/modules/
 drivers        airlocks: web, github, mailbox,           server/src/airlocks/
                + connections: any MCP server or OpenAPI API
 executables    blueprints                                    server/blueprints/
 shell          React app                                     web/
 users / ACLs   system SQLite: users, members, shares, links  server/src/kernel/system-db.ts
```

## Run

**Upgrading an existing instance?** Follow the [offline migration guide](docs/upgrading-to-outpost.md) first. Outpost 0.8 changes configuration, APIs, saved schemas and module runtime names without compatibility aliases.

Requires Node ≥ 22.19 (uses built-in `node:sqlite`) and pnpm.

```bash
pnpm install
pnpm start            # builds the web app, serves everything on http://127.0.0.1:8787
```

Development, with hot reload for both server and web:

```bash
pnpm dev              # server on :8787 (tsx watch), web on http://localhost:5173 (proxies /api, /ws, /frame)
```

Sign up. The first account gets a personal workspace. Invite others by username in **Settings → Members**, or share single modules.

**Chats and modules stay linked.** A chat lists the modules it created or worked on, with **Open** links below its header. Opening a module selects a related chat (keeping the current one if it is related, otherwise the most recent), and the sidebar marks other related items separately from the active item. Browsing the sidebar alone doesn't create links. Existing chats recover links from recorded tool activity; archived chats stay out of navigation.

### Configuration

Outpost reads one file: **`outpost.config.json`** in the directory you start it from, or the path in `OUTPOST_CONFIG`. It doesn't read any other tool's config. Without the file, defaults apply. Start from the example:

```bash
cp outpost.config.example.json outpost.config.json
```

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 8787 },
  "dataDir": "./data",                       // relative to the config file
  "models": {
    "default": "anthropic/claude-sonnet-4-5",  // for new chats; workspaces can override
    "providers": {                             // keyed by pi provider id
      "anthropic": { "apiKey": "$ANTHROPIC_API_KEY" },        // "$VAR" reads the env; literals work too
      "azure": { "apiKey": "$AZURE_OPENAI_API_KEY", "env": { "AZURE_OPENAI_BASE_URL": "https://…" } },
      "groq": { "enabled": false }                          // hide a provider
    },
    "ambientEnv": true,                        // also accept providers' standard env vars
    "demo": true                               // offer the offline demo model
  },
  "airlocks": { "github": { "token": "$GITHUB_TOKEN" } }
}
```

### Models and keys

Outpost can use every provider pi-ai supports: Anthropic, OpenAI, Google, Azure, Bedrock, OpenRouter, Groq, Mistral, DeepSeek, xAI, and more. Each provider's key comes from the first of these that is set:

1. **`models.providers.<id>.apiKey`** in the config file. Keys set here are read-only in the UI.
2. **Settings → Model providers → Add key.** These are stored in `<dataDir>/credentials.enc.json`, encrypted with AES-256-GCM using the instance secret (`<dataDir>/secret.key`, or `OUTPOST_SECRET`).
3. The provider's **standard env var** (`ANTHROPIC_API_KEY`, …). Set `models.ambientEnv: false` to turn this off.

**GitHub Copilot** uses a subscription sign-in instead of a key. Go to **Settings → Model providers → Sign in with GitHub**, copy the code, and approve it at github.com/login/device. Leave the domain prompt blank for github.com, or enter your GitHub Enterprise domain. The flow runs on the server (device code, so the browser doesn't need to be on the same machine). The token is stored in the encrypted credential store and refreshed automatically. The model picker shows only the models your Copilot plan allows. Other subscription logins aren't offered; those providers take API keys.

Unknown provider IDs and `$VAR`s that aren't set produce warnings at startup.

New chats use `models.default`, unless the workspace sets its own, falling back to the first available model. You can change the model per chat. With no keys at all, an offline **Demo** model follows a few scripts ("make a todo list", "make slides", …).

### Environment overrides

| Variable | Overrides |
|---|---|
| `OUTPOST_CONFIG` | config file path |
| `PORT`, `HOST` | `server.port`, `server.host` |
| `OUTPOST_DATA` | `dataDir`, which holds the system DB, one `workspaces/<id>.sqlite` per workspace, the secret, and stored credentials |
| `OUTPOST_SECRET` | the generated `secret.key` (32 bytes, as hex or base64) |
| `OUTPOST_PREVIEW_BIND`, `OUTPOST_PREVIEW_PORTS` | `preview.bind`, `preview.ports` — where browsers reach live previews (`0.0.0.0`, `"3100-3199"` in a container) |

### Files

Attach files to a message with 📎, drag-and-drop, or paste (Ctrl+V a screenshot), or drop them on the **Files** page. Any format is accepted, up to `files.maxUploadMB` (default 100). Bytes are stored content-addressed in `<dataDir>/workspaces/<id>.files/`. The index lives in the durable `outpost.files` document.

- **What the model sees:** images are sent inline (resized with Photon when large), small text files are inlined, and everything else arrives as a handle such as `[Attached file f_…: "name" — kind, mime, size]`.
- **Taking files apart:** the agent never gets a fixed list of supported formats. Instead it has byte-level primitives: `file_info` (sniffed kind, magic bytes, preview, zip entries), `file_read` (text/hex/base64 ranges), `file_search`, `file_unzip` (docx/xlsx/pptx/epub/jar …), `file_inflate` (gzip/zlib/deflate ranges, e.g. PDF streams), `file_view` (images), and `file_write` for outputs.
- **Tooling it builds itself:** when a format needs real parsing or an interactive view, the agent writes a module whose server parses the file and then uses the module's API as its tool. Module servers use `ctx.files.list/info/text/bytes/write`. Files are capabilities: a module reads only files shared with it (`file_share_with_module`, or the checkboxes in the Files preview) and files it wrote itself.
- **Safe serving:** downloads are always sent with `sandbox` CSP and `nosniff`. Only images, plain text and PDF render inline; HTML and SVG are always downloaded.

### Moving blueprints and modules between instances

Export to a single `.outpost.json` file and import it on another Outpost:
- **One module:** ⋯ → *Export* (code only) or *Export with data* (also what it has stored).
- **One blueprint:** *Export* on its card, built-ins included.
- **In bulk:** *Blueprints → Export…* exports your blueprints and the current workspace's modules, optionally with their data.
- **Import:** *Blueprints → Import…* previews the file first. Blueprints go to your library, private unless you choose to share them. Modules go into the current workspace, owned by you.

Code and data travel. Shares, share links, Airlock grants, logs, and workspace files a module's data points to stay on the old instance; grant access again after importing.

**Version and capability checks.** Exports record the Outpost version and module runtime that produced them, and what each item needs: the server features (`ctx.storage`, `ctx.files`, …), page features (`module.api`, `module.onPresence`, …) and Airlocks (with methods) it uses. Import re-detects these from the code (a file can't skip the check by declaring less; legacy formats and runtimes require migration) and rates every item before anything is created:
- ⛔ **can't run here**: it needs a newer module runtime, or a feature this Outpost doesn't provide. It isn't imported.
- ⚠ **partly works**: it calls a Airlock or method this Outpost doesn't have (those calls fail), or the file comes from a newer outpost.
- ✓ **runs here** (with a note on which Airlock access to grant again).

The Import dialog shows the check before importing, and the import skips blocked items and reports why. `GET /api/capabilities` describes an instance; `POST /api/w/:ws/import/check` checks a file without importing it. The agent that builds modules gets the same rules: its guide's *Compatibility* section is generated from `compat.ts` (runtime version, the `ctx`/`module` members, this instance's Airlocks), and `module_write` / `module_edit` return a `compat` problem as soon as code uses something outside them. When a change to the module API breaks existing modules, bump `MODULE_RUNTIME` in `packages/server/src/modules/compat.ts`; new features are checked by name and need no bump. Add a new feature to `SERVER_FEATURES` / `CLIENT_FEATURES` and document it in the guide (a test fails if the guide misses one). Imported code runs in the same sandbox as any module. The importer checks the format, version, file paths, sizes and counts, and rejects anything else.

### Missions: agent teams

**Missions → +** takes a high-level goal. A **Lead** agent forms a team for that goal (product owner, architect, developers, reviewer, … as needed). The team writes requirements, a design and code in a git repository at `<dataDir>/missions/<id>/repo`. Each agent works in its own git worktree and merges into `main` with `publish`. The mission page shows a live tile per agent around an artifact viewer with tabs: Overview (goal, questions waiting for you, activity), Requirements, Design, Wireframes and Repo (files and history of `main`). Click a tile to read that agent's full transcript and message it. The Lead asks you to approve the requirements before work continues.

The **Backlog** tab is a Kanban board (To do / In progress / Review / Done) of the planner's features → PBIs → tasks, with a Structure view for review. You approve the backlog or send it back with a comment before building starts, and you can drag cards and edit items. `docs/backlog.md` is regenerated from it. Click the model in the mission header to change the mission's default model (optionally for every agent); each agent's drawer has its own model picker.

**The build** starts when you approve the backlog, and Outpost runs it, not an LLM:
- It hands each free developer the next ready task (dependencies done, preferring a part of `app/` nobody else is in).
- `task_done` sends the work to the reviewer. **Approve** merges exactly that commit into `main`; **changes** sends it back to the developer with the notes.
- An agent that stops mid-task is reminded twice, then the task is marked blocked and the Lead is told.
- The Backlog tab shows the progress, with a Pause / Resume button. Each task's panel shows what was submitted and its history. Tiles show the task each agent is on.

**Document gates.** The Lead submits the requirements, then the design, for your approval; you approve or request changes on the Requirements and Design tabs. The backlog can't be approved before both are (missions created before gates existed aren't held to this).

**Quality gates in the build.** Developer briefs inline the design sections and decision records the Planner named for each task, what dependencies delivered, and the last retrospective's actions. `task_done` runs the mission's `test` command (`.outpost/mission.json`) on the submitted commit; failing work goes back to the developer. The reviewer approves only by confirming the **definition of done** (Outpost defaults plus the mission's `definitionOfDone`). If `main` moved since the submission, Outpost tests the merge result before moving `main`. The task panel shows the checks with their output and the confirmed checklist. When a build finishes, Outpost writes `docs/retrospectives/NNNN-date.md` with its facts and the Lead adds lessons (Overview → Retrospective).

**Fewer merge conflicts.** Outpost's generated files (`docs/backlog.md`, `docs/retrospectives/`) take `main`'s version on every merge; repositories use LF line endings and a repo-local "outpost agents" git identity, so agents' own git commands behave the same on every machine; tasks with overlapping areas (one path inside the other) don't run in parallel.

**Questions and readiness.** An agent's question is *blocking* (it waits for you) or *non-blocking* (it states its assumption and carries on). While a blocking question is open, nothing can be approved to build. Answer, dismiss, or re-flag questions on the Overview tab.

**Feedback.** The App tab's Feedback panel sends your feedback on the running app to the Planner as FB-n, tied to the version you saw. The Planner drafts PBIs and tasks for it. They, and anything agents add after you approved the backlog, wait as **pending** until you approve them on the Backlog tab. You can also make a PBI from feedback yourself, or decline it.

The **App** tab runs the product from `main`:
- It uses `.outpost/mission.json`, which the architect writes: `install`, `dev` with `$PORT`, and `readyPath`.
- It runs in its own checkout, on a free port, with logs.
- It reinstalls when dependency manifests change and restarts after every merge that touches `app/`.
- Agents check it with the `preview` tool.

Agents run shell commands **on this machine** (Git Bash on Windows) inside their worktree. The file tools can't write outside it. The development process (stages, roles, gates, artifacts, task lifecycle, and how it compares with Waterfall, Scrum, Kanban and BMAD): [docs/methodology.md](docs/methodology.md). Design and roadmap: [docs/design/agent-teams.md](docs/design/agent-teams.md). Done: the team, tiles, transcripts, repo layout, the backlog with its approval gate, the build scheduler (M4) and the live preview (M5). Next: dedicated approve buttons for requirements and design, and iteration on feedback.

## Docker

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
[not sandboxed](#known-limits) — the container is the boundary.

**Size.** ~1.8 GB, most of it Chromium. Skip `chromium` from the `apt-get` line and set
`render.enabled: false` in the config if you don't need `module_screenshot`.

## The workspace homepage

`#/w/<workspace>` — the bare workspace URL, or the **π** logo in the sidebar — is the workspace's
homepage, not a chat. Chats live at `#/w/<ws>/c/<id>`. The page answers two questions:

- **Where was I?** The last chat, missions with questions waiting on you, approvals to decide — one
  click each — plus quick actions to start a chat or give a team a goal.
- **What happened while I was away?** What the agents did since you last opened the workspace: runs per
  chat (messages, which tools, a snippet of what it said), missions that moved, modules edited,
  approvals decided, files added.

"While you were away" measures from the last time *you* opened the homepage, stored per user; a
workspace you have never opened looks back a week.

Chat transcripts carry no wall-clock time of their own — a durable entry is an ordered record, not a
timestamped one — so every finished agent run is written down as it ends, from the run's own event
stream, whether or not anyone has the chat open. That record is deliberately small: counts, tool names
and the agent's last words, capped at the newest 300 runs.

The digest itself is facts only and costs nothing. **Summarise these chats** asks the model for one
line per chat, caches it until that chat has newer runs, and is skipped on the demo model. What is sent
to the model is the run snippets and tool names, never the transcript.

## How it maps onto pi-durable

| Concept | pi-durable primitive |
|---|---|
| Workspace | one `Harness` over `openNodeSqliteStorage(data/workspaces/<id>.sqlite)` |
| Chat | an ownerless `Conversation`. Messages are submitted with an `outpost.user` entry carrying the author. Steering and follow-ups use `whenBusy` |
| Live transcript | `watchEvents()` streamed over WebSocket to every member watching |
| Agent tools | one `outpost` extension (module, blueprint, Airlock and subagent tools, plus prompt sections), along with `createCodemodeExtension` |
| Subagents | a task-owned child conversation (`ownership: { kind: "task" }`), `replay: "safe"` |
| Module code / storage / logs | session document families `outpost.module.source` / `.state` / `.logs` |
| Grants, access requests, approvals, audit | session documents `outpost.grants`, `outpost.approvals`, `outpost.audit` |
| Telling the agent that something happened (grant, approval) | a `write` submission whose entry carries a model-visible message, placed at the next turn boundary |
| Crash recovery | `harness.resume()` on start. Every workspace is reopened at boot |

### Module runtime

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

### Airlocks

Every Airlock exposes a typed API scoped to one resource. Each method is either `read` or `write`.

- Grants are held by a **chat**, a **module**, or a **mission team** (optionally only some roles, e.g. its developers). Nothing is ambient: a module can't use its chat's grants, and vice versa.
- **Reads** run right away. Pending writes are **overlaid** on later reads, so a queued "create issue" appears in `list_issues`.
- **Writes** return a simulated result immediately and add an action to the approval queue. Approving runs the real call. The outcome is reported back to the chat that asked, and `action_result` reads it. Grants can opt into auto-approve, or set it per method: ask, auto, or refuse.
- Every call is written to the audit log.

Built in:

- `web`: one HTTP origin.
- `github`: one repository: issues, files, comments.
- `mailbox`: a local outbox for trying approvals with no external account.

To add a built-in one, put a definition in `server/src/airlocks/catalog.ts`. Most services don't need one: add them as connections.

### Connections: any MCP server or REST API

A **connection** turns a third-party service into a Airlock with no service-specific code (`server/src/airlocks/connectors/`, built on the official MCP SDK and `@apidevtools/swagger-parser`):

- **MCP server** (streamable HTTP, falling back to SSE): its tools become methods. Tools the server marks `readOnlyHint: true` are reads; everything else is a write; `destructiveHint: true` always asks.
- **REST API** with an OpenAPI 3 or Swagger 2 document (by URL, or pasted): its operations become methods. GET/HEAD are reads; POST/PUT/PATCH are writes; DELETE always asks. **Fixed parameters** (`organization=contoso`) are sent with every call and hidden from agents, so a connection can be pinned to one organization or project.

- **Azure DevOps**, hand-written (`connectors/azure-devops.ts`; Microsoft no longer publishes OpenAPI documents, and its hosted MCP server needs Entra sign-in): about 30 methods over the REST API (7.1) for boards (WIQL queries, work items, comments, links, iterations), repos and pull requests (files, branches, create, comment, vote, complete), pipelines and builds (run, failures, logs) and wiki. One organization per connection, optionally one project (then agents can't name another). Personal access token. Deleting work items, voting and completing pull requests always ask. A work item or pull request waiting for approval shows up in queries with a `pending:` id, and a later action can use that id: approving it first runs the one it depends on.

A connection is the workspace's account on the service (a shared service account): workspace owners add them on the **Connections** page (auth: bearer token, API key in a header or the URL, or basic; basic's username may be empty, as for Azure DevOps personal access tokens). Secrets are encrypted with the instance secret (`data/connections.enc.json`) and never sent back to the browser or shown to agents. A connection gives nobody access by itself: you introduce it to a chat, module or mission (🔑 Resources), choosing the methods and, per write, ask / auto / refuse. An owner can mark a write as a read ("treat as read").

Trust:

- **Added in the UI** ("byo"): public hosts only (private, loopback, link-local and metadata addresses are refused, redirects can't leave the host), and writes are never auto-approved.
- **Declared by an admin** in `outpost.config.json` (`connectors`): vetted. May reach private hosts, may run a local MCP command (stdio), and writes may be auto-approved (except always-ask ones). They appear in every workspace, or only those listed.

```json
"connectors": [
  { "id": "linear", "kind": "mcp", "url": "https://mcp.linear.app/mcp", "auth": { "kind": "bearer", "token": "$LINEAR_TOKEN" } },
  { "id": "files", "kind": "mcp", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared"] },
  { "id": "inventory", "kind": "openapi", "spec": "https://inventory.internal/openapi.json", "auth": { "kind": "header", "name": "x-api-key", "value": "$INVENTORY_KEY" }, "reads": ["searchItems"] }
]
```

**Agents can propose connections.** Ask in a chat ("connect us to Linear") and the agent finds the endpoint and drafts it with `propose_connection`: the MCP URL or OpenAPI document, how it authenticates, why, and how to get the key, but never the key itself (the tool has no field for one, and agents are told never to ask for keys in chat). The draft waits under Connections (with a sidebar badge, and in Approvals & access). An owner reviews it in a pre-filled form, types the key and connects it, or declines; the agent is told either way and then asks for access with `request_access`.

Agents see their capabilities in `<resources>` (methods, and whether each reads, asks, runs or is refused), look methods up with `airlock_tools`, call them with `airlock_call`, and ask for a connection by its label with `request_access`. A write on a connection queues and returns `{status: "pending", actionId}`: a generic connector can't fake what the service would return. Modules call connections the same way: `ctx.airlocks["<label>"].<method>(args)`.

## Test

```bash
pnpm test                                     # build + typecheck + every suite below (~1.5 min)
pnpm --filter @outpost/server test -- build ui  # just some suites
```

Each suite runs in its own process with a throwaway data dir and never reads your `outpost.config.json`, keys or data. Everything runs on the offline demo model, so no API key is needed. GitHub Actions runs `pnpm test` on Linux and Windows for every push to `master` and every pull request (`.github/workflows/test.yml`).

| Suite | Covers |
|---|---|
| `migration` | offline data conversion, durable revision replay, module code, permissions, credential/file preservation and git worktree migration without committing unrelated work |
| `teams` | backlog edits, refs and validation, the `docs/backlog.md` snapshot, approval, mission/agent model controls, agents can't write outside their worktree |
| `transfer` | export/import of blueprints and modules between two running instances (code, data, visibility, permissions, validation, version and capability checks) |
| `home` | the workspace homepage: runs recorded while nobody watches, the per-user "seen" boundary, a second visit reporting only what is new, summaries skipped on the demo model, non-members refused |
| `quality` | M2 document gates, story-style briefs, tests before review and before merge (incl. merge results when main moved), definition of done, retrospective, restart resume |
| `conflicts` | generated files never conflict, LF line endings and repo identity (new and older repos), real conflicts still reported, overlapping areas not run in parallel |
| `connectors` | MCP servers (HTTP and stdio) and OpenAPI REST APIs as Airlocks against local fixtures: discovery and read/write classification, secrets never leaving the server, the private-address guard, method subsets and per-method policy, byo never auto-approved, the approval queue and `action_result`, mission grants by role, revoke and remove |
| `azure-devops` | the Azure DevOps connector against a stand-in for dev.azure.com: token check and rejected tokens, WIQL queries, JSON Patch creates, comments on a work item still waiting for approval, pull requests, always-ask methods, a fixed project, proposals for unknown organizations |
| `gates` | blocking and non-blocking questions, readiness, feedback → pending items → approval, make-PBI, decline/reopen |
| `build` | M4 scheduler (assignment, dependencies, review, changes, merge, roll-up, pause) and M5 preview (starts after a merge, restarts on the next, kills the old dev server, stop) |
| `preview` | `preview.ports` (the container case): the browser port comes from the range, the app stays on loopback, two missions run side by side, stopping frees the port |
| `smoke` | HTTP + WebSocket end to end: accounts, chat → module, module RPC and rollback, frame CSP, sharing, roles, presence, live sync, Airlocks and approvals, files, blueprints |
| `render` | `module_screenshot`: scratch vs persisted renders, actions, console and error capture (needs Chrome/Edge/Chromium) |
| `module-chat` | persistent chat/module relationships, historical recovery, subagent ownership, sidebar highlights and Open links, reloads, archived chats and deleted modules |
| `ui` | the web app in a headless browser: the workspace homepage, chat, sidebar ⋯ menus, the model picker, and Blueprints import/export dialogs, and the mission page (Side/Team layouts, tiles, attachments, repo tree, backlog build bar, task history, App tab preview, question cards and readiness, feedback panel, pending approval), Connections (add a REST API, its methods) and granting a connection to a chat and to a mission's developers. `SHOTS=<dir>` saves screenshots |

Browser suites skip themselves when no browser is found (set `OUTPOST_CHROME`). `HEADFUL=1` shows the browser in `ui`. Write new suites on `test/lib/harness.ts` (import it first) and add them to `test/run.ts`.

## Known limits

- Module servers are QuickJS VMs in the main process, not separate worker isolates. They have no outbound network and no timers or alarms.
- Airlocks run in-process and use shared service-account keys (a token in `outpost.config.json`, or a connection's key) rather than per-user OAuth sign-in.
- Realtime collaboration is method calls plus broadcasts, not CRDT/OT text editing.
- Single process: storage has one owner, so there's no horizontal scaling.
