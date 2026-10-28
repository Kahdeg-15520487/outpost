# Tests

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
| `github` | the GitHub repository connector against a stand-in for api.github.com: token and repository checks, scoping to one repository, path safety, approved writes, redaction, proposals |
| `azure-devops` | the Azure DevOps connector against a stand-in for dev.azure.com: token check and rejected tokens, WIQL queries, JSON Patch creates, comments on a work item still waiting for approval, pull requests, always-ask methods, a fixed project, proposals for unknown organizations |
| `gates` | blocking and non-blocking questions, readiness, feedback → pending items → approval, make-PBI, decline/reopen |
| `build` | M4 scheduler (assignment, dependencies, review, changes, merge, roll-up, pause) and M5 preview (starts after a merge, restarts on the next, kills the old dev server, stop) |
| `preview` | `preview.ports` (the container case): the browser port comes from the range, the app stays on loopback, two missions run side by side, stopping frees the port |
| `smoke` | HTTP + WebSocket end to end: accounts, chat → module, module RPC and rollback, frame CSP, sharing, roles, presence, live sync, Airlocks and approvals, files, blueprints |
| `render` | `module_screenshot`: scratch vs persisted renders, actions, console and error capture (needs Chrome/Edge/Chromium) |
| `offline` | a real server stopped and restarted under an open tab: the offline banner and toast, failed actions explained, recovery, network-only drops, toast dismissal |
| `module-chat` | persistent chat/module relationships, historical recovery, subagent ownership, sidebar highlights and Open links, reloads, archived chats and deleted modules |
| `ui` | the web app in a headless browser: the workspace homepage, chat, sidebar ⋯ menus, the model picker, and Blueprints import/export dialogs, and the mission page (Side/Team layouts, tiles, attachments, repo tree, backlog build bar, task history, App tab preview, question cards and readiness, feedback panel, pending approval), Connections (add a REST API, its methods) and granting a connection to a chat and to a mission's developers. `SHOTS=<dir>` saves screenshots |

Browser suites skip themselves when no browser is found (set `OUTPOST_CHROME`). `HEADFUL=1` shows the browser in `ui`. Write new suites on `test/lib/harness.ts` (import it first) and add them to `test/run.ts`.
