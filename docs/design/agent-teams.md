# Agent teams: goal → plan → working product

Status: **approved** — M1, M3, M4 (build scheduler: assign → task_done → review → merge) and M5 (live preview from `.pios/project.json`) done, with per-project and per-agent model controls. M2's requirements/design gates still go through the Lead's question (good enough for the MVP). A real-model run (Haiku) went from goal to a running, reviewed, merged app unattended in ~6 minutes. Covered by `pnpm test` (suites `build`, `teams`, `ui`). Next: M6 (iteration on feedback, resilience).

## What it is

You give pi-os a high-level goal ("a booking app for our meeting rooms"). A team of agents turns it into
requirements, a design, a backlog (features → PBIs → tasks), and then real code in a git repository on disk,
built by several worker agents in parallel. You approve the requirements and the backlog; after that the team
runs on its own. The whole time you watch it on one screen: a live tile per agent around an artifact viewer
that shows the documents, the backlog, and the running app.

```
┌──────┬──────┬────────────────────────────────────┬──────┬──────┐
│ Lead │ PO   │  Artifact viewer                   │ W1   │ W2   │
│ ●    │ ✓    │  [Goal][Requirements][Design]      │ ●    │ ●    │
├──────┼──────┤  [Wireframes][Backlog][App][Repo]  ├──────┼──────┤
│ Arch │ Plan │                                    │ W3   │ QA   │
│ ✓    │ ✓    │  (live app preview / doc / board)  │ ○    │ ●    │
├──────┼──────┤                                    ├──────┼──────┤
│ ...  │      │  ⚑ Backlog ready — Approve / Revise│      │      │
└──────┴──────┴────────────────────────────────────┴──────┴──────┘
```

## Decisions (from you)

| Question | Answer |
|---|---|
| What gets built | Real code projects: a folder on disk, any stack; agents use bash/files; pi-os runs the dev server and previews it |
| Human in the loop | Approve requirements, approve backlog; then autonomous |
| Agent tile | Live status (role, task, streaming output); click → full transcript, message that agent |
| Roles | Lead decides team composition per goal (PO, Architect, Planner, N Workers, Reviewer/QA as a default shape) |
| Cost limits | None for now (token usage is still shown per agent and per project) |
| Repo location | Always a new folder under the data dir |

## Lifecycle

| Stage | Who | Produces | Ends when |
|---|---|---|---|
| 1. Kickoff | Lead | team plan (roles, how many workers), questions for you if the goal is too vague | Lead starts discovery |
| 2. Discovery | Product Owner | `docs/requirements.md` (problem, users, scope, non-goals, acceptance criteria) | **Gate 1: you approve** (or send feedback → revise) |
| 3. Design | Architect | `docs/design.md`, `docs/wireframes/*.html`, optional proof of concept, `.pios/project.json` (how to install, test, run the dev server) | Architect hands off |
| 4. Planning | Planner | backlog: features → PBIs (with acceptance criteria) → tasks (with dependencies, file areas, estimates) | **Gate 2: you approve** (edit, reorder, delete items first if you like) |
| 5. Build | Workers + Reviewer, scheduled by pi-os | code on task branches, reviewed and merged into `main`; the app preview restarts after each merge | every task is done |
| 6. Iterate | you + Lead | your feedback on the running app becomes new PBIs/tasks (no gate for small changes) | you close the project |

## Architecture

### Projects and repos
- A project = goal + team + backlog + a git repo, always a new folder at `<dataDir>/projects/<id>/repo`
  (worktrees in `<dataDir>/projects/<id>/worktrees/`).

#### Repository layout (decided)
```
<dataDir>/projects/<id>/
├─ repo/                          git; `main` = what the viewer shows
│  ├─ README.md                   what the product is + how to run it
│  ├─ .pios/project.json          install / test / dev commands pi-os runs (inside app/)
│  ├─ app/                        everything the application needs to build and run, nothing else
│  └─ docs/
│     ├─ requirements.md          Product Owner
│     ├─ design.md                Architect
│     ├─ backlog.md               written by pi-os from the live backlog (read-only snapshot)
│     ├─ decisions/NNNN-<slug>.md decision records (context, options, decision, consequences)
│     ├─ wireframes/<screen>.html self-contained HTML
│     └─ prototypes/<name>/       throwaway proofs of concept; app/ never imports them
├─ attachments/                   the user's uploads: outside git, read in place by agents, cited by name
└─ worktrees/<agent>/             each agent's checkout, on branch agent/<key>
```
- `app/` holds the application and nothing else; nothing the application needs lives outside it. No other
  top-level folders. The repo is scaffolded with this layout at kickoff; every agent's prompt carries it.
- The backlog's source of truth is pi-os (structured, live, approvable); `docs/backlog.md` is regenerated from it.
- Attachments stay out of git so the repo stays lean; the Overview tab lists them with download links. An asset
  the app really needs is copied into `app/` deliberately, with a decision record.

#### Agents and branches
- Every agent works in **its own git worktree** on its own branch (`task/<taskId>`), so parallel workers never
  step on each other's files. The Reviewer reviews the diff, runs the tests from `.pios/project.json`, and merges
  into `main`; a merge conflict goes back to the worker to rebase.
- Agents get pi-durable's built-in `read`/`write`/`edit`/`bash` tools with `cwd` = their worktree
  (Git Bash on Windows), plus project tools (below). **Agents run commands on this machine** — the project
  page says so, and Docker sandboxing is a follow-up.

### Agents on pi-durable
- Each agent is a durable conversation in the workspace's Harness, tagged with project + role, so a restart
  resumes every agent mid-thought (this is the main reason pi-durable fits).
- The **Lead** is an LLM agent with tools to form the team (`team_add(role, brief, model?)`), message agents,
  open gates, and handle exceptions. Role prompts are per-role system prompt sections.
- The **scheduler** is deterministic code (a durable pi-durable task), not an LLM: it picks ready tasks
  (dependencies done), assigns them to idle workers, creates the worktree, submits the task brief, waits for
  `task_done`, hands the branch to the Reviewer, merges, restarts the preview. Reliable dispatch, no tokens
  spent on bookkeeping.
- Agents talk through project tools, not free chat: `backlog_*` (create/update items), `artifact_publish`,
  `task_done(summary)`, `task_blocked(reason)`, `ask_lead(question)`, `ask_user(question)` (shows on the
  agent's tile and in the project inbox).

### State (live)
- Backlog, team, stage, gates, artifacts index: pi-durable session docs → pushed to every viewer over the
  existing WebSocket hub (same mechanism as gadgets and chats today).
- Documents and wireframes are files in the repo (`docs/…`), so they are versioned with the code.

### Live preview
- `.pios/project.json` (written by the Architect, editable by you):
  `{ "install": "npm ci", "test": "npm test", "dev": { "command": "npm run dev -- --port $PORT", "readyPath": "/" } }`
- pi-os runs `dev` on the `main` checkout on a free port, shows it in the **App** tab (iframe to
  `http://127.0.0.1:<port>`), streams its logs, and restarts it after merges.

### UI
- Sidebar: **Projects** section; `+ New project` asks for the goal.
- Project page = the mockup: agent tiles on both sides (2 columns each, more scroll), artifact viewer in the
  middle with tabs: **Goal · Requirements · Design · Wireframes · Backlog · App · Repo** (files + commit log).
- Tile: role, model, current task, state (thinking / running a tool / waiting / idle / blocked), last lines
  of output, tokens. Click → drawer with the full transcript (reusing the chat transcript component) and a
  message box to steer that agent.
- Gate banner in the viewer when the team is waiting on you: **Approve** / **Request changes** (with a comment).
- Project controls: pause / resume / stop all agents.

## Milestones

| # | Milestone | Done when |
|---|---|---|
| M1 | **Projects + team foundation** — project model, repo + worktrees, project page (tiles + viewer shell), Lead agent that forms a team and spawns role agents, live tiles, transcript drawer + messaging | You create a project, the Lead proposes a team, agents appear as live tiles you can open and talk to |
| M2 | **Discovery + design** — PO and Architect roles, requirements/design/wireframe tabs, Gate 1 | Requirements and design docs appear in the viewer; approve/revise works |
| M3 | **Backlog** — backlog model and tools, Planner role, Backlog tab (tree + board, editable), Gate 2 | An approved backlog of features → PBIs → tasks with dependencies |
| M4 | **Build** — scheduler, parallel workers in worktrees, Reviewer + merge, task status on the board | Approved tasks get built in parallel and merged into `main` |
| M5 | **Live preview** — `.pios/project.json`, dev server manager, App tab, restart on merge, logs | You watch the app change as tasks merge |
| M6 | **Iterate + resilience** — feedback → new PBIs, pause/resume/stop, crash recovery checks, Repo tab | A full goal → app run survives a server restart and takes follow-up feedback |

Each milestone is usable on its own and ends with a browser-verified demo, tests, and a commit.

## Out of scope for now
Cost/budget limits, Docker sandboxing, multiple repos per project, pushing to remote git hosts, mixing
gadgets into projects.
