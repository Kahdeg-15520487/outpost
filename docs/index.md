# Outpost documentation

Start with the [README](../README.md) for what Outpost is and how to run it. This folder holds the
detail behind each feature.

## Using it

| Page | What it covers |
|---|---|
| [workspace.md](workspace.md) | chats and module links, archiving, the offline banner, the workspace homepage, keyboard navigation |
| [files.md](files.md) | uploads, native ingestion (docx/xlsx/pptx/pdf/archives), the parsed and design models, the file tools |
| [artifacts.md](artifacts.md) | `![[f_…]]` embeds: tables and charts, JSON with jq-lite, Markdown that writes back, sandboxed HTML |
| [missions.md](missions.md) | agent teams: roles, backlog, build scheduler, gates, feedback, live preview |
| [modules.md](modules.md) | the module runtime: QuickJS server, sandboxed client, roles, screenshots |
| [airlocks.md](airlocks.md) | capabilities, grants, simulated writes and approvals |
| [connections.md](connections.md) | MCP servers, OpenAPI APIs, GitHub and Azure DevOps as airlocks |
| [transfer.md](transfer.md) | exporting and importing blueprints and modules, with version and capability checks |

## Running it

| Page | What it covers |
|---|---|
| [configuration.md](configuration.md) | `outpost.config.json`, providers and keys, environment overrides |
| [docker.md](docker.md) | the container, volumes, preview ports, TLS |
| [upgrading-to-outpost.md](upgrading-to-outpost.md) | migrating an existing instance (no compatibility aliases) |
| [limits.md](limits.md) | what Outpost does not do yet |

## How it is built

| Page | What it covers |
|---|---|
| [architecture.md](architecture.md) | the pi-durable primitives behind workspaces, chats, tools and documents |
| [testing.md](testing.md) | the suites, what each covers, and the harness |
| [methodology.md](methodology.md) | the development process missions follow, compared with Waterfall, Scrum, Kanban and BMAD |
| [design/agent-teams.md](design/agent-teams.md) | mission design and roadmap |
| [design/airlocks.md](design/airlocks.md) | airlock design and threat model |
