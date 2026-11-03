# Missions: agent teams

**Missions → +** takes a high-level goal. A **Lead** agent forms a team for that goal (product owner, architect, developers, reviewer, … as needed). The team writes requirements, a design and code in a git repository at `<dataDir>/missions/<id>/repo`. Each agent works in its own git worktree and merges into `main` with `publish`. The mission page shows a live tile per agent around an artifact viewer with tabs: Overview (goal, questions waiting for you, activity), Requirements, Design, Wireframes and Repo (files and history of `main`). Click a tile to read that agent's full transcript and message it. The Lead asks you to approve the requirements before work continues.

The **Backlog** tab is a Kanban board (To do / In progress / Review / Done) of the planner's features → PBIs → tasks, with a Structure view for review. You approve the backlog or send it back with a comment before building starts, and you can drag cards and edit items. `docs/backlog.md` is regenerated from it. Click the model in the mission header to change the mission's default model (optionally for every agent); each agent's drawer has its own model picker.

**The build** starts when you approve the backlog, and Outpost runs it, not an LLM:
- It hands each free developer the next ready task (dependencies done, preferring a part of `app/` nobody else is in).
- `task_done` sends the work to the reviewer. **Approve** merges exactly that commit into `main`; **changes** sends it back to the developer with the notes.
- An agent that stops mid-task is reminded twice, then the task is marked blocked and the Lead is told.
- The Backlog tab shows the progress, with a Pause / Resume button. Each task's panel shows what was submitted and its history. Tiles show the task each agent is on.

**Document gates.** The Lead submits the requirements, then the design, for your approval, and the tabs show it: approve, or request changes. The backlog can't be approved before both are (missions created before gates existed aren't held to this).

**A review is a checklist, not a yes/no.** A request carries the *items* the Lead wants settled — the choices, the open points, the things it most wants checked — and you answer them one at a time on the document's tab: **✓ Looks right**, or **✎ Change this** with a note for the team. The count at the top says how far along you are, the verdicts are stored as you click, and "Request changes" starts from the items you flagged (you can edit the note before it goes). The gate itself is still decided once, because a document on `main` is one file and git has no half-approval: approving is refused while an item is flagged, and clearing the flag is one click. Requests made before items existed carry their bullets as the checklist, so an older pending review reads the same way.

The Lead is told to keep the summary to a couple of sentences and put the document on the tab rather than in the request. A long request is folded behind "What the lead said about it" so the checklist is the first thing you see.

**Quality gates in the build.** Developer briefs inline the design sections and decision records the Planner named for each task, what dependencies delivered, and the last retrospective's actions. `task_done` runs the mission's `test` command (`.outpost/mission.json`) on the submitted commit; failing work goes back to the developer. The reviewer approves only by confirming the **definition of done** (Outpost defaults plus the mission's `definitionOfDone`). If `main` moved since the submission, Outpost tests the merge result before moving `main`. The task panel shows the checks with their output and the confirmed checklist. When a build finishes, Outpost writes `docs/retrospectives/NNNN-date.md` with its facts and the Lead adds lessons (Overview → Retrospective).

**Fewer merge conflicts.** Outpost's generated files (`docs/backlog.md`, `docs/retrospectives/`) take `main`'s version on every merge; repositories use LF line endings and a repo-local "outpost agents" git identity, so agents' own git commands behave the same on every machine; tasks with overlapping areas (one path inside the other) don't run in parallel.

**From a chat.** The workspace assistant has mission tools, so a conversation can start a team and keep it moving without opening the mission page: `mission_start` (a goal, optionally files from Files), `mission_list` and `mission_read` (stage, gates, open questions, backlog progress, feedback, recent activity, preview — and `waitingOnYou`, which is why nothing is happening), `mission_answer` (an agent's question, which is what unblocks a stopped team), `mission_message` (the Lead, or one agent by key) and `mission_feedback` (FB-n for the planner). It cannot decide a gate: approving the requirements, the design or the backlog is your reading of a document, and a tool that let an agent approve its own mission's documents would make the gate decorative. The assistant says which tab is waiting and you decide there. Tool calls carry the workspace owner's name, like the rest of its writes.

**What the team knows about the workspace.** Every agent's brief carries a `<workspace_apps>` section naming the modules the user already runs and the blueprints available. A mission's product is a repository of its own, so a module can't be installed into it or called from it — but a team that designs a second contacts app beside the user's Contacts module has wasted the money, so the design is expected to name the companion and the data path between them, and to say so before designing a product when the goal is really a small app a module could cover. `mission_read` also reports what the team has spent (tokens and cost, the same numbers the mission header shows).

**Visibility.** A mission shows up wherever the rest of Outpost does: the workspace homepage lists its missions and flags the ones waiting on you, `Approvals` shows the access a team asks for, and its model comes from the same registry as every chat.

**Questions and readiness.** An agent's question is *blocking* (it waits for you) or *non-blocking* (it states its assumption and carries on). While a blocking question is open, nothing can be approved to build. Answer, dismiss, or re-flag questions on the Overview tab.

**Feedback.** The App tab's Feedback panel sends your feedback on the running app to the Planner as FB-n, tied to the version you saw. The Planner drafts PBIs and tasks for it. They, and anything agents add after you approved the backlog, wait as **pending** until you approve them on the Backlog tab. You can also make a PBI from feedback yourself, or decline it.

The **App** tab runs the product from `main`:
- It uses `.outpost/mission.json`, which the architect writes: `install`, `dev` with `$PORT`, and `readyPath`.
- It runs in its own checkout, on a free port, with logs.
- It reinstalls when dependency manifests change and restarts after every merge that touches `app/`.
- Agents check it with the `preview` tool.

Agents run shell commands **on this machine** (Git Bash on Windows) inside their worktree. The file tools can't write outside it. The development process (stages, roles, gates, artifacts, task lifecycle, and how it compares with Waterfall, Scrum, Kanban and BMAD): [methodology.md](methodology.md). Design and roadmap: [design/agent-teams.md](design/agent-teams.md). Done: the team, tiles, transcripts, repo layout, the backlog with its approval gate, the build scheduler (M4) and the live preview (M5). Next: iteration on feedback.
