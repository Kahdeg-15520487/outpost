import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { hub } from "../collab/hub.ts";
import { BacklogDoc, depsDone, pushHistory, rollUp, type Backlog, type BacklogItem } from "./backlog.ts";
import type { AgentRecord, ProjectState } from "./docs.ts";
import type { ProjectManager } from "./manager.ts";

/**
 * The build scheduler (milestone 4): deterministic code, not an LLM.
 *
 *   todo ──assign──▶ doing ──task_done──▶ review ──approve──▶ (merge) done
 *                      ▲                    │
 *                      └──── changes ───────┘      blocked ⇄ (lead / user)
 *
 * - Once the backlog is approved (and the build isn't paused) every free developer (role `worker`,
 *   holding no task in doing/review/blocked) gets the next ready task: status todo, all dependencies
 *   done, preferring an `area` nobody is working in. pi-os syncs the developer's worktree with main
 *   and sends the brief.
 * - `task_done` commits the developer's branch with main merged in (repo.submit); that commit is what
 *   gets reviewed and merged, so later edits can't sneak in. With a reviewer on the team, a free
 *   reviewer gets the commit checked out (detached) in their worktree and a review brief; their
 *   `review_verdict` merges it (approve) or sends notes back to the developer (changes). Without a
 *   reviewer, submitted work merges at once.
 * - An agent that ends its turn while holding a task (no task_done, no question pending) is nudged
 *   twice, then the task is marked blocked and the lead is told.
 * - All state lives in the backlog document, written in commits; deliveries happen after the commit
 *   and are marked (`briefed`), so a restart re-sends exactly the briefs that hadn't gone out.
 */
export class BuildScheduler {
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #running = new Map<string, Promise<void>>();
	/** Remind idle agents that hold a task (tests turn it off: their scripted agents never call the tools). */
	nudges = true;

	constructor(readonly m: ProjectManager) {}

	/** Run a pass soon (coalesces bursts of events). */
	kick(projectId: string, delay = 300) {
		clearTimeout(this.#timers.get(projectId));
		this.#timers.set(
			projectId,
			setTimeout(() => {
				this.#timers.delete(projectId);
				void this.run(projectId);
			}, delay),
		);
	}

	/** One pass, serialized per project. */
	run(projectId: string): Promise<void> {
		const prev = this.#running.get(projectId) ?? Promise.resolve();
		const next = prev.then(() => this.#pass(projectId)).catch((e) => console.warn(`[build ${projectId}]`, e?.stack ?? e));
		this.#running.set(projectId, next);
		return next;
	}

	/** Change the backlog in one commit; bumps the revision and refreshes docs/backlog.md only if `fn` says it changed something. */
	async #edit<T>(projectId: string, fn: (b: Backlog) => { changed: boolean; result: T }): Promise<T> {
		let out!: { changed: boolean; result: T };
		await this.m.ws.harness.commit(async (tx) => {
			const b = (await tx.doc(BacklogDoc, projectId, null)) as Backlog;
			out = fn(b);
			if (out.changed) b.revision += 1;
		}, ctx);
		if (out.changed) this.m.snapshotSoon(projectId);
		return out.result;
	}

	async #pass(projectId: string) {
		const meta = await this.m.meta(projectId).catch(() => undefined);
		if (!meta || meta.archived) return;
		const state = await this.m.state(projectId);
		const live = (a: AgentRecord | undefined) => !!a && !a.removed;
		const devs = state.order.map((k) => state.agents[k]!).filter((a) => live(a) && a.role === "worker");
		const reviewers = state.order.map((k) => state.agents[k]!).filter((a) => live(a) && a.role === "reviewer");

		type Action = { kind: "brief"; task: BacklogItem; agent: string } | { kind: "review"; task: BacklogItem; agent: string } | { kind: "merge"; id: string } | { kind: "started" } | { kind: "finished"; tasks: number };
		const actions = await this.#edit(projectId, (b) => {
			const acts: Action[] = [];
			let changed = rollUp(b);
			if (b.approval.status !== "approved") return { changed, result: acts };
			const tasks = Object.values(b.items)
				.filter((i) => i.type === "task")
				.sort((x, y) => taskOrder(b, x) - taskOrder(b, y));
			if (!tasks.length) return { changed, result: acts };
			b.build ??= {};
			if (!b.build.startedAt) {
				b.build.startedAt = Date.now();
				changed = true;
				acts.push({ kind: "started" });
			}

			// Briefs that were assigned but never sent (crash between commit and delivery).
			for (const t of tasks) {
				if (t.status === "doing" && t.assignee && !t.briefed && live(state.agents[t.assignee])) acts.push({ kind: "brief", task: plain(t), agent: t.assignee });
				if (t.status === "review" && t.reviewer && !t.reviewBriefed && live(state.agents[t.reviewer])) acts.push({ kind: "review", task: plain(t), agent: t.reviewer });
			}

			if (!b.build.paused) {
				// Assign ready tasks to free developers.
				const holding = (key: string) => tasks.some((t) => t.assignee === key && (t.status === "doing" || t.status === "review" || t.status === "blocked"));
				const activeAreas = new Set(tasks.filter((t) => t.status === "doing" && t.area).map((t) => t.area!));
				for (const dev of devs) {
					if (holding(dev.key)) continue;
					// Tasks pinned (by the lead or the user) to another developer wait for them.
					const ready = tasks.filter((t) => t.status === "todo" && (!t.assignee || t.assignee === dev.key || !live(state.agents[t.assignee])) && depsDone(b, t));
					const pick = ready.find((t) => t.assignee === dev.key) ?? ready.find((t) => !t.area || !activeAreas.has(t.area)) ?? ready[0];
					if (!pick) continue;
					pick.status = "doing";
					pick.assignee = dev.key;
					pick.attempt = (pick.attempt ?? 0) + 1;
					pick.briefed = false;
					pick.nudges = 0;
					pick.updatedAt = Date.now();
					pushHistory(pick, "pi-os", `Assigned to ${dev.name}`);
					if (pick.area) activeAreas.add(pick.area);
					changed = true;
					acts.push({ kind: "brief", task: plain(pick), agent: dev.key });
				}
			}

			// Route submitted work: to a free reviewer, or straight to main when the team has none.
			const reviewing = (key: string) => tasks.some((t) => t.status === "review" && t.reviewer === key);
			for (const t of tasks.filter((t) => t.status === "review" && t.submitted && (!t.reviewer || !live(state.agents[t.reviewer])))) {
				if (!reviewers.length) {
					acts.push({ kind: "merge", id: t.id });
					continue;
				}
				const r = reviewers.find((r) => !reviewing(r.key) && r.key !== t.assignee);
				if (!r) break;
				t.reviewer = r.key;
				t.reviewRound = (t.reviewRound ?? 0) + 1;
				t.reviewBriefed = false;
				t.nudges = 0;
				t.updatedAt = Date.now();
				pushHistory(t, "pi-os", `Review by ${r.name}`);
				changed = true;
				acts.push({ kind: "review", task: plain(t), agent: r.key });
			}

			if (rollUp(b)) changed = true;
			if (tasks.every((t) => t.status === "done") && !b.build.finishedAt) {
				b.build.finishedAt = Date.now();
				changed = true;
				acts.push({ kind: "finished", tasks: tasks.length });
			} else if (b.build.finishedAt && tasks.some((t) => t.status !== "done")) {
				delete b.build.finishedAt;
				changed = true;
			}
			return { changed, result: acts };
		});

		for (const a of actions) {
			try {
				if (a.kind === "started") {
					await this.m.setStage(projectId, "build", "the backlog is approved; pi-os assigns tasks to developers");
					if (!devs.length) await this.m.tellLead(projectId, "The build has started, but the team has no developers (role `worker`) for pi-os to assign tasks to. Add some with team_add (start: false; pi-os sends them their tasks).");
				} else if (a.kind === "brief") await this.#brief(projectId, a.task, state.agents[a.agent]!);
				else if (a.kind === "review") await this.#reviewBrief(projectId, a.task, state.agents[a.agent]!, state);
				else if (a.kind === "merge") await this.merge(projectId, a.id, "no reviewer on the team");
				else if (a.kind === "finished") {
					await this.m.log(projectId, { at: Date.now(), kind: "stage", text: `All ${a.tasks} tasks are done and merged` });
					await this.m.tellLead(projectId, `All ${a.tasks} backlog tasks are done and merged into main. The App tab runs the latest main. Check the result against the requirements (the preview tool shows its status and logs), tell the user what was built, and set the stage to iterate.`);
				}
			} catch (e: any) {
				console.warn(`[build ${projectId}] ${a.kind}:`, e?.message ?? e);
				await this.m.log(projectId, { at: Date.now(), kind: "error", text: `Build: ${a.kind} failed: ${e?.message ?? e}` });
			}
		}
	}

	async #brief(projectId: string, t: BacklogItem, dev: AgentRecord) {
		const b = await this.m.backlog(projectId);
		const pbi = t.parent ? b.items[t.parent] : undefined;
		const feature = pbi?.parent ? b.items[pbi.parent] : undefined;
		await this.m.repo(projectId).sync(dev.key);
		const deps = t.deps.map((d) => b.items[d]).filter(Boolean) as BacklogItem[];
		const prior = (t.history ?? []).filter((h) => h.by !== "pi-os" || /review|conflict|blocked/i.test(h.text)).slice(-4);
		const text = [
			`**Task ${t.id}: ${t.title}**${t.estimate ? ` (${t.estimate})` : ""}${t.area ? ` · area \`${t.area}\`` : ""}`,
			t.description ? `\n${t.description}` : "",
			pbi ? `\nPart of ${pbi.id} “${pbi.title}”${feature ? ` (feature ${feature.id} “${feature.title}”)` : ""}.${pbi.acceptance?.length ? `\nAcceptance criteria of ${pbi.id}:\n${pbi.acceptance.map((c) => `- ${c}`).join("\n")}` : ""}` : "",
			deps.length ? `\nBuilt on (already merged): ${deps.map((d) => `${d.id} ${d.title}`).join("; ")}.` : "",
			prior.length ? `\nEarlier on this task:\n${prior.map((h) => `- ${h.by}: ${h.text}`).join("\n")}` : "",
			`\nYour worktree is synced with main. Read the design and decision records that matter, implement the task in \`app/\`, and run the tests. When it's complete, call **task_done** with a short summary: pi-os commits your branch, has it reviewed and merges it. If you can't finish it, call **task_blocked** with what you need. Don't publish task work yourself.`,
		].join("");
		await this.m.deliver(projectId, dev.key, { from: "pi-os", fromKey: "pi-os", text, kind: "message" }, `assign:${t.id}:${t.attempt ?? 1}`);
		await this.#mark(projectId, t.id, (i) => void (i.briefed = true));
		await this.m.log(projectId, { at: Date.now(), agent: dev.key, kind: "team", text: `${dev.name} started ${t.id} “${clip(t.title, 70)}”` });
	}

	async #reviewBrief(projectId: string, t: BacklogItem, reviewer: AgentRecord, state: ProjectState) {
		if (!t.submitted) return;
		const b = await this.m.backlog(projectId);
		const pbi = t.parent ? b.items[t.parent] : undefined;
		await this.m.repo(projectId).checkoutDetached(reviewer.key, t.submitted.commit);
		const author = state.agents[t.assignee ?? ""]?.name ?? t.assignee ?? "a developer";
		const text = [
			`**Review ${t.id}: ${t.title}** (round ${t.reviewRound ?? 1}), submitted by ${author}.`,
			t.description ? `\n${t.description}` : "",
			pbi?.acceptance?.length ? `\nAcceptance criteria of ${pbi.id} “${pbi.title}”:\n${pbi.acceptance.map((c) => `- ${c}`).join("\n")}` : "",
			`\nTheir summary: ${t.submitted.summary}`,
			`\nFiles changed: ${t.submitted.files.join(", ") || "(none)"}`,
			`\nThe submitted commit ${t.submitted.commit.slice(0, 10)} is checked out (detached) in your worktree. See the change with \`git diff main...HEAD\`; install, build and run the tests in \`app/\`. Check it against the task, the acceptance criteria, the design, the decision records and the repository layout.`,
			`\nThen call **review_verdict** for ${t.id}: \`approve\` (pi-os merges it into main) or \`changes\` with concrete, actionable notes (it goes back to ${author}). Don't edit the code yourself.`,
		].join("");
		await this.m.deliver(projectId, reviewer.key, { from: "pi-os", fromKey: "pi-os", text, kind: "message" }, `review:${t.id}:${t.attempt ?? 1}:${t.reviewRound ?? 1}`);
		await this.#mark(projectId, t.id, (i) => void (i.reviewBriefed = true));
		await this.m.log(projectId, { at: Date.now(), agent: reviewer.key, kind: "team", text: `${reviewer.name} is reviewing ${t.id} “${clip(t.title, 70)}”` });
	}

	async #mark(projectId: string, id: string, fn: (i: BacklogItem) => void) {
		await this.#edit(projectId, (b) => {
			const i = b.items[id];
			if (i) fn(i);
			return { changed: !!i, result: undefined };
		});
	}

	// ------------------------------------------------------------------ agent actions (tools)

	/** The task an agent works on (developer) or reviews (reviewer). */
	async heldBy(projectId: string, key: string) {
		const b = await this.m.backlog(projectId);
		const tasks = Object.values(b.items).filter((t) => t.type === "task");
		return {
			working: tasks.find((t) => t.assignee === key && t.status === "doing"),
			reviewing: tasks.filter((t) => t.reviewer === key && t.status === "review"),
		};
	}

	/** task_done: submit the developer's branch for review. */
	async taskDone(projectId: string, dev: AgentRecord, summary: string, noChanges: boolean): Promise<string> {
		const { working: t } = await this.heldBy(projectId, dev.key);
		if (!t) throw new Error("You have no task in progress. pi-os sends you your next task when one is ready.");
		const r = await this.m.repo(projectId).submit(dev.key, `${t.id}: ${t.title}`);
		if (r.conflict) return r.conflict;
		if (!r.files.length && !noChanges) return `Your branch has no changes compared to main, so there's nothing to review. Implement ${t.id} first. If it really needs no change (already done by an earlier task), call task_done again with no_changes: true and say why in the summary.`;
		await this.#edit(projectId, (b) => {
			const i = b.items[t.id]!;
			i.status = "review";
			i.submitted = { commit: r.commit!, summary, at: Date.now(), by: dev.key, files: r.files };
			delete i.reviewer;
			i.nudges = 0;
			i.updatedAt = Date.now();
			pushHistory(i, dev.name, `Submitted: ${summary}`);
			return { changed: true, result: undefined };
		});
		await this.m.log(projectId, { at: Date.now(), agent: dev.key, kind: "team", text: `${dev.name} finished ${t.id} “${clip(t.title, 60)}” (${r.files.length} file${r.files.length === 1 ? "" : "s"})` });
		this.kick(projectId, 50);
		return `Submitted ${t.id} (${r.files.length} file${r.files.length === 1 ? "" : "s"} changed). It goes to review and is merged when approved. Stop here: the review result or your next task arrives as a message.`;
	}

	/** task_blocked: hand the problem to the lead. */
	async taskBlocked(projectId: string, dev: AgentRecord, reason: string): Promise<string> {
		const { working: t } = await this.heldBy(projectId, dev.key);
		if (!t) throw new Error("You have no task in progress.");
		await this.block(projectId, t.id, dev.name, reason);
		return `${t.id} is marked blocked and the lead has your reason. Stop here; you'll hear back.`;
	}

	async block(projectId: string, id: string, by: string, reason: string) {
		const t = await this.#edit(projectId, (b) => {
			const i = b.items[id]!;
			i.status = "blocked";
			i.updatedAt = Date.now();
			pushHistory(i, by, `Blocked: ${reason}`);
			return { changed: true, result: plain(i) };
		});
		await this.m.log(projectId, { at: Date.now(), agent: t.assignee, kind: "error", text: `${t.id} “${clip(t.title, 60)}” is blocked: ${clip(reason, 140)}` });
		await this.m.tellLead(
			projectId,
			`Task **${t.id} “${t.title}”** (${t.assignee ? `@${t.assignee}` : "unassigned"}) is **blocked**: ${reason}\n\nUnblock it: answer the developer with \`message\` and set the task back to doing with backlog_update, or change the task, or ask the user. pi-os won't give that developer other work while they hold a blocked task (unassign it to free them).`,
		);
	}

	/** review_verdict from the reviewer. */
	async verdict(projectId: string, reviewer: AgentRecord, id: string, verdict: "approve" | "changes", notes: string): Promise<string> {
		const b = await this.m.backlog(projectId);
		const t = b.items[id];
		if (!t || t.type !== "task") throw new Error(`No task ${id}.`);
		if (t.status !== "review" || t.reviewer !== reviewer.key) throw new Error(`${id} isn't waiting for your review (status ${t.status}${t.reviewer ? `, reviewer ${t.reviewer}` : ""}).`);
		if (verdict === "approve") {
			await this.#edit(projectId, (b) => {
				pushHistory(b.items[id]!, reviewer.name, `Approved${notes ? `: ${notes}` : ""}`);
				return { changed: true, result: undefined };
			});
			const merged = await this.merge(projectId, id, reviewer.name);
			await this.m.repo(projectId).checkoutOwnBranch(reviewer.key).catch(() => {});
			return merged ? `Approved and merged into main as ${merged}. Stop here; your next review arrives as a message.` : `Approved, but it didn't merge cleanly; it went back to the developer to resolve. Stop here.`;
		}
		if (!notes.trim()) throw new Error("Say what has to change: concrete, actionable notes.");
		const dev = await this.#edit(projectId, (b) => {
			const i = b.items[id]!;
			i.status = "doing";
			delete i.reviewer;
			i.reviewBriefed = false;
			i.nudges = 0;
			i.updatedAt = Date.now();
			pushHistory(i, reviewer.name, `Changes requested: ${notes}`);
			return { changed: true, result: i.assignee };
		});
		await this.m.repo(projectId).checkoutOwnBranch(reviewer.key).catch(() => {});
		await this.m.log(projectId, { at: Date.now(), agent: reviewer.key, kind: "team", text: `${reviewer.name} sent ${id} back: ${clip(notes, 120)}` });
		if (dev) await this.m.deliver(projectId, dev, { from: reviewer.name, fromKey: reviewer.key, text: `**Review of ${id} “${t.title}”: changes requested.**\n\n${notes}\n\nFix it on your branch, run the tests, and call task_done again.`, kind: "message" }, `changes:${id}:${t.attempt ?? 1}:${t.reviewRound ?? 1}`);
		this.kick(projectId, 50);
		return `Sent back to ${dev ?? "the developer"} with your notes. Stop here; you'll review it again when it's resubmitted.`;
	}

	/** Merge a task's submitted commit into main. Returns the merge commit, or undefined when it conflicted (the task goes back to its developer). */
	async merge(projectId: string, id: string, by: string): Promise<string | undefined> {
		const b = await this.m.backlog(projectId);
		const t = b.items[id];
		if (!t?.submitted) return undefined;
		const repo = this.m.repo(projectId);
		const r = await repo.mergeCommit(t.submitted.commit, `${t.id}: ${t.title} (${t.assignee ?? "?"})`);
		if (r.conflict) {
			await this.#edit(projectId, (b) => {
				const i = b.items[id]!;
				i.status = "doing";
				delete i.reviewer;
				i.updatedAt = Date.now();
				pushHistory(i, "pi-os", `Merge conflict with main in ${r.conflict}`);
				return { changed: true, result: undefined };
			});
			if (t.assignee) await this.m.deliver(projectId, t.assignee, { from: "pi-os", fromKey: "pi-os", text: `${t.id} was approved, but main moved on and it no longer merges cleanly (conflicts in ${r.conflict}). Run \`git merge main\` in your worktree, resolve the conflicts, run the tests, and call task_done again.`, kind: "message" }, `conflict:${id}:${t.submitted.commit.slice(0, 12)}`);
			this.kick(projectId, 50);
			return undefined;
		}
		await this.#edit(projectId, (b) => {
			const i = b.items[id]!;
			i.status = "done";
			i.merged = r.commit;
			delete i.reviewer;
			i.updatedAt = Date.now();
			pushHistory(i, "pi-os", `Merged into main as ${r.commit}${by === "no reviewer on the team" ? " (no reviewer on the team)" : ""}`);
			rollUp(b);
			return { changed: true, result: undefined };
		});
		await this.m.log(projectId, { at: Date.now(), agent: t.assignee, kind: "publish", text: `${t.id} “${clip(t.title, 70)}” merged into main (${r.files.length} file${r.files.length === 1 ? "" : "s"})` });
		hub.publish(this.m.channel(projectId), { t: "project.repo", ws: this.m.ws.id, project: projectId, head: r.commit, files: r.files });
		this.m.mainChanged(projectId, r.files);
		this.kick(projectId, 50);
		return r.commit;
	}

	// ------------------------------------------------------------------ idle agents

	/**
	 * An agent finished a run. If it still holds a task and isn't waiting on anyone (no queued input, no
	 * unanswered question), remind it; after two reminders the task is blocked and the lead takes over.
	 */
	async agentIdle(projectId: string, key: string) {
		if (!this.nudges) return;
		const b = await this.m.backlog(projectId);
		if (b.approval.status !== "approved") return;
		const state = await this.m.state(projectId);
		const agent = state.agents[key];
		if (!agent || agent.removed) return;
		if (Object.values(state.questions).some((q) => q.agent === key && !q.answeredAt)) return;
		const sum = this.m.summaries.get(projectId)?.[key];
		if (sum?.busy || (sum?.queued ?? 0) > 0) return;
		const { working, reviewing } = await this.heldBy(projectId, key);
		const t = working ?? reviewing[0];
		if (!t || (working ? !t.briefed : !t.reviewBriefed)) return;
		if (Date.now() - t.updatedAt < 1500) return;
		const n = (t.nudges ?? 0) + 1;
		if (n > 2) {
			await this.block(projectId, t.id, "pi-os", `${agent.name} stopped working on it ${working ? "without task_done" : "without a review_verdict"} after two reminders`);
			return;
		}
		await this.#mark(projectId, t.id, (i) => void (i.nudges = n));
		const text = working
			? `You still have **${t.id} “${t.title}”** in progress. Continue it; when it's complete call task_done (with a summary), or task_blocked if you can't finish it.`
			: `You're reviewing **${t.id} “${t.title}”**. Finish the review and call review_verdict (approve, or changes with notes).`;
		await this.m.deliver(projectId, key, { from: "pi-os", fromKey: "pi-os", text, kind: "message" }, `nudge:${t.id}:${t.attempt ?? 1}:${t.reviewRound ?? 0}:${n}`);
	}

	// ------------------------------------------------------------------ user controls

	async setPaused(projectId: string, paused: boolean, by: string) {
		await this.#edit(projectId, (b) => {
			b.build ??= {};
			if (paused) b.build.paused = true;
			else delete b.build.paused;
			return { changed: true, result: undefined };
		});
		await this.m.log(projectId, { at: Date.now(), kind: "user", text: `${by} ${paused ? "paused" : "resumed"} the build` });
		if (!paused) this.kick(projectId, 50);
	}
}

/** A detached copy of a document value (copies made inside a commit must not keep its proxies). */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Backlog order across the tree: feature, then PBI, then task. */
function taskOrder(b: Backlog, t: BacklogItem) {
	const pbi = t.parent ? b.items[t.parent] : undefined;
	const feature = pbi?.parent ? b.items[pbi.parent] : undefined;
	return (feature?.order ?? 0) * 1e8 + (pbi?.order ?? 0) * 1e4 + t.order;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
