# Outpost

A self-hosted AI workspace on Node, with [**pi-durable**](https://github.com/earendil-works/pi/tree/main/packages/durable) as the kernel.

- **Agents that survive crashes.** Every chat is a pi-durable conversation: model turns, tool calls and app state are committed before they are shown, so a run killed mid-flight resumes from its last checkpoint.
- **Modules.** Small apps the agent writes for you: a sandboxed client, a sandboxed server with durable storage, multiplayer by default, and an API that doubles as the agent's tool surface.
- **Airlocks.** Access arrives as an explicit capability, never ambiently. Side effects are simulated and queued for bulk approval.
- **Files that keep their fidelity.** docx, xlsx, pptx, pdf and archives are parsed natively — content *and* design (fonts, colours, geometry) — and embedded back into a chat as interactive tables, queries and pages.
- **Blueprints, sharing, live multiplayer.** Share a module with people or by link (viewer or editor), or publish its code so others get their own copy.

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

Requires Node ≥ 22.19 (built-in `node:sqlite`) and pnpm.

```bash
pnpm install
pnpm start            # builds the web app, serves everything on http://127.0.0.1:8787
pnpm dev              # server :8787 (tsx watch) + web :5173 with hot reload
```

Sign up; the first account gets a personal workspace. Invite others by username in **Settings → Members**, or share single modules.

Outpost reads one file, `outpost.config.json` in the directory you start it from (or `OUTPOST_CONFIG`), and nothing else — no other tool's config. Start from `outpost.config.example.json`. Providers, keys, Copilot sign-in and environment overrides: **[docs/configuration.md](docs/configuration.md)**.

**Upgrading an existing instance?** Follow the [offline migration guide](docs/upgrading-to-outpost.md) first. Outpost 0.8 renamed configuration, APIs, saved schemas and the module runtime without compatibility aliases.

## Features

| Feature | In one line | Docs |
|---|---|---|
| **Chats** | Durable conversations that stream live to everyone watching; the modules a chat created or touched stay linked to it | [workspace](docs/workspace.md) |
| **Workspace homepage** | `#/w/<ws>` answers "where was I" and "what happened while I was away", from facts, not tokens | [workspace](docs/workspace.md) |
| **Archive** | Modules and chats leave the sidebar, home and agent lists but keep code, data and shares, and restore from the Archived section | [workspace](docs/workspace.md) |
| **Offline** | A closed socket or unanswered request gets a banner, one toast, and clear failures — nothing is disabled | [workspace](docs/workspace.md) |
| **Keyboard** | Slides' keys across the shell: arrows/`j`/`k`/`Space` move, `Enter` opens, `Escape` drops | [workspace](docs/workspace.md) |
| **Files** | Any format in, content-addressed storage, attachments ingested as parsed content, byte-level tools for anything unsupported | [files](docs/files.md) |
| **Ingestion** | docx (mammoth), xlsx (ExcelJS), pdf (pdf.js), pptx (own OOXML walker) and zip/tar/gz/rar/7z — parsed lazily, cached by hash, design model kept | [files](docs/files.md) |
| **Artifacts** | `![[f_…]]` in a reply renders the file inline: sortable tables and charts, JSON with jq-lite, Markdown that writes back, sandboxed HTML | [artifacts](docs/artifacts.md) |
| **Diagrams** | `` ```mermaid `` fences and `.mmd` files draw in place — flowcharts, sequences, states and the rest — with the source a click away | [artifacts](docs/artifacts.md#diagrams) |
| **Modules** | QuickJS server (no network, no timers), sandboxed client, transactional calls, roles, headless screenshots for the agent | [modules](docs/modules.md) |
| **Airlocks** | Typed methods per resource, read or write; grants per chat/module/mission-role; writes simulated, queued and audited | [airlocks](docs/airlocks.md) |
| **Connections** | Any MCP server or OpenAPI document becomes an airlock; GitHub and Azure DevOps by hand; Ask/Allow per method | [connections](docs/connections.md) |
| **Blueprints & transfer** | Export/import modules and blueprints as one file, with version and capability checks before anything is created | [transfer](docs/transfer.md) |
| **Missions** | A Lead forms a team; requirements, design, backlog and code in real git worktrees; a deterministic build scheduler, gates, retrospectives, live preview | [missions](docs/missions.md) |
| **Docker** | One container with git and Chromium; `/data` volume; preview port range for the App tab | [docker](docs/docker.md) |

## Test

```bash
pnpm test                                        # build + typecheck + 19 suites (~2 min)
pnpm --filter @outpost/server test -- build ui   # just some suites
```

Each suite gets a throwaway data directory, its own config and the offline demo model, so it never
touches your data or calls a paid provider. CI runs it on Linux and Windows. What each suite covers:
**[docs/testing.md](docs/testing.md)**.

## Elsewhere in the docs

- [How it maps onto pi-durable](docs/architecture.md) — what a workspace, chat, tool or document *is* in the kernel.
- [Known limits](docs/limits.md) — what Outpost deliberately does not do yet.
- [Documentation index](docs/index.md) — every page.
