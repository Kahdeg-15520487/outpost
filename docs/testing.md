# Tests

## Test

```bash
pnpm test                                     # build + typecheck + every suite below (~4 min)
pnpm test:responsive                          # the responsive suite (Playwright, all devices)
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
| `ui` | the web app in a headless browser: the workspace homepage, chat, sidebar ⋯ menus, the model picker, and Blueprints import/export dialogs, and the mission page (Side/Team layouts, tiles, attachments, repo tree, backlog build bar, task history, App tab preview, question cards and readiness, feedback panel, pending approval), Connections (add a REST API, its methods) and granting a connection to a chat and to a mission's developers, and a phone pass (390×844, 768×1024, 1280×900, landscape) checking that no screen scrolls sideways, that the sidebar becomes a panel, that dialogs become sheets and that a module takes the window. `SHOTS=<dir>` saves screenshots |

## The responsive suite (Playwright)

The suites above drive a browser with puppeteer and assert behaviour. Layout across devices needs
something different: the same app at five sizes, checked both structurally and as pixels.

```bash
pnpm test:responsive                       # every project: desktop, laptop, tablet, phone
pnpm test:responsive --project=phone       # one device
pnpm test:responsive:update                # re-take the pixel baselines, then review the diff
pnpm test:responsive:report                # the HTML report from the last run
```

It lives in `packages/server/test/responsive/` and is started by `playwright.config.ts` at the repo
root. Playwright starts `fixture.ts` as its `webServer`: a throwaway data directory, a config with no
providers but the offline demo, and a small seeded workspace (an account, a chat with one exchange,
two files and a module from a built-in blueprint). Nothing touches your data.

**Two layers, on purpose.**

- `layout.spec.ts` — structural truth: the app fills the window and the page never scrolls, no screen
  scrolls sideways, the navigation is a panel with a menu button on small screens and a docked column
  on large ones, a chat and its module are side by side on a wide window and stacked with a divider
  under 1100px, a module is laid out at a desktop width and scaled on a phone, dialogs are bottom
  sheets on a phone, fields are 16px and targets are thumb-sized on touch. This layer runs on every
  project and is the one that fails the build.
- `visual.spec.ts` — `toHaveScreenshot()` baselines under
  `__snapshots__/<project>/<platform>/`. It catches what nobody thought to assert: a margin that
  moved, a clipped card, text behind a panel. Opt in with `RESPONSIVE_SNAPSHOTS=1`.

The projects are device descriptors, not window sizes: `Pixel 7` and `iPad (gen 7)` bring their own
viewport, device pixel ratio and touch flags, which is what makes `(hover: none)` and `(pointer: fine)`
answer the way they do on the real thing.

**Baselines are per platform.** Font rendering differs between Windows and Linux, so a screenshot
only means something on the platform that made it, and the path template keeps them apart. Generate
baselines where you will compare them: locally with `pnpm test:responsive:update`, or in CI with the
`update_snapshots` workflow input, which uploads the `__snapshots__` folder as an artifact to commit.

What is deliberately *not* asserted: text that moves between runs (times, token counts, model names)
is masked rather than hoped-for; animations are frozen for screenshots, and finished explicitly before
any measurement (`getAnimations().finish()`), because Playwright's `animations: "disabled"` only
applies to screenshots — a sheet measured mid-slide sits 20px below the screen.

Browser suites skip themselves when no browser is found (set `OUTPOST_CHROME`). `HEADFUL=1` shows the browser in `ui`. Write new suites on `test/lib/harness.ts` (import it first) and add them to `test/run.ts`.
