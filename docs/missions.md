# Missions: agent teams

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

Agents run shell commands **on this machine** (Git Bash on Windows) inside their worktree. The file tools can't write outside it. The development process (stages, roles, gates, artifacts, task lifecycle, and how it compares with Waterfall, Scrum, Kanban and BMAD): [methodology.md](methodology.md). Design and roadmap: [design/agent-teams.md](design/agent-teams.md). Done: the team, tiles, transcripts, repo layout, the backlog with its approval gate, the build scheduler (M4) and the live preview (M5). Next: dedicated approve buttons for requirements and design, and iteration on feedback.
