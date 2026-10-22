import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { hub } from "../collab/hub.ts";
import { HttpError, newId, type User } from "../kernel/system-db.ts";
import { models as modelRegistry } from "../kernel/models.ts";
import { formatBytes } from "../files/store.ts";
import type { Workspace } from "../kernel/workspace.ts";
import { ACTIVITY_LIMIT, ProjectDoc, ProjectsDoc, type Activity, type AgentRecord, type ProjectMeta, type ProjectStage, type ProjectState } from "./docs.ts";
import { ProjectRepo } from "./repo.ts";
import { join } from "node:path";
import { BacklogDoc, PARENT_TYPE, STATUSES, STATUS_LABEL, addItems, backlogOutline, emptyBacklog, renderBacklog, type Backlog, type BacklogItem, type ItemInput } from "./backlog.ts";
import { agentInstructions, roleCatalog, roleDef } from "./roles.ts";
import { AgentWatcher, type AgentSummary } from "./watch.ts";
import { BuildScheduler } from "./build.ts";
import { PreviewManager } from "./preview.ts";

type ModelRef = { provider: string; modelId: string };
/** A user file handed to the team: its absolute path in the attachments folder, plus what the transcript's file chips need. */
export type Attached = { id: string; name: string; kind: string; mime: string; size: number; path: string };

function describeFiles(files: Attached[]) {
	if (!files.length) return "";
	return `\n\n[Attachments from the user. They live outside the repo, in the project's attachments folder: read them in place with \`read\` (text, images) or bash (PDF, Office, archives). Don't copy them into the repo; cite them by file name in docs and decision records.]\n${files.map((f) => `- ${f.path} (${f.kind}, ${f.mime}, ${formatBytes(f.size)})`).join("\n")}`;
}
const STAGES: ProjectStage[] = ["kickoff", "discovery", "design", "planning", "build", "iterate", "done"];

const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

function keyBase(role: string, name?: string) {
	if (role === "lead") return "lead";
	if (role === "product-owner") return "po";
	if (role === "worker") return "dev";
	const slug = (name || role).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	return slug.slice(0, 24) || "agent";
}

function parseModel(s?: string): ModelRef | undefined {
	if (!s) return undefined;
	const [provider, ...rest] = s.split("/");
	return provider && rest.length ? { provider, modelId: rest.join("/") } : undefined;
}

/**
 * Agent teams in one workspace: projects, their agents (durable conversations, each in its own git
 * worktree), the tools agents coordinate with, and the live summaries the project page shows.
 */
export class ProjectManager {
	readonly coding: Extension;
	readonly extension: Extension;
	readonly #leadOnly: any[];
	/** conversation id → which project/agent it is. */
	readonly #byConversation = new Map<string, { projectId: string; key: string }>();
	readonly #watchers = new Map<string, AgentWatcher>();
	readonly summaries = new Map<string, Record<string, AgentSummary>>();
	readonly #docWatches = new Map<string, Promise<unknown>>();
	/** Milestone 4: assigns tasks, routes reviews, merges. */
	readonly build: BuildScheduler;
	/** Milestone 5: runs the app from main for the App tab. */
	readonly previews: PreviewManager;

	constructor(readonly ws: Workspace) {
		this.build = new BuildScheduler(this);
		this.previews = new PreviewManager(this);
		this.coding = createCodingTools();
		const tools = this.#tools();
		this.#leadOnly = tools.filter((t) => ["team_add", "set_stage"].includes(t.name));
		this.extension = defineExtension({ name: "pios-project", tools });
	}

	channel(projectId: string) {
		return `project:${this.ws.id}:${projectId}`;
	}

	repo(projectId: string) {
		return new ProjectRepo(projectId);
	}

	/** Index every agent and start following it, after the Harness opens. */
	async init() {
		await this.ws.harness.commit(async (tx) => void (await tx.doc(ProjectsDoc)), ctx);
		const projects = (await this.ws.harness.snapshot(ProjectsDoc, ctx))?.projects ?? {};
		for (const p of Object.values(projects)) {
			if (p.archived) continue;
			const state = await this.state(p.id);
			for (const a of Object.values(state.agents)) {
				if (a.removed) continue;
				this.#follow(p.id, a);
				// Agents keep the instructions they were created with; bring them up to date with this version
				// of pi-os (new tools, repo layout), so a running project picks up improvements on restart.
				const c = await this.ws.harness.conversation(Number(a.conversationId) as any, ctx).catch(() => undefined);
				const instructions = agentInstructions({ role: a.role, title: titleFor(a.role), key: a.key, name: a.name, project: p, brief: a.brief, attachmentsDir: this.repo(p.id).attachmentsDir });
				await c?.configure({ instructions }, ctx).catch((e) => console.warn(`[project ${p.id}] refresh ${a.key}:`, e?.message ?? e));
			}
			// Resume the build: re-send briefs that never went out, assign what's ready.
			this.build.kick(p.id, 3000);
		}
	}

	async list(): Promise<ProjectMeta[]> {
		const projects = (await this.ws.harness.snapshot(ProjectsDoc, ctx))?.projects ?? {};
		return Object.values(projects)
			.filter((p) => !p.archived)
			.sort((a, b) => b.createdAt - a.createdAt);
	}

	async meta(projectId: string): Promise<ProjectMeta> {
		const p = (await this.ws.harness.snapshot(ProjectsDoc, ctx))?.projects?.[projectId];
		if (!p) throw new HttpError(404, "No such project");
		return p;
	}

	async state(projectId: string): Promise<ProjectState> {
		return ((await this.ws.harness.snapshot(ProjectDoc, projectId, ctx)) as ProjectState | undefined) ?? { agents: {}, order: [], questions: {}, activity: [] };
	}

	async snapshot(projectId: string) {
		const [meta, state, backlog] = await Promise.all([this.meta(projectId), this.state(projectId), this.backlog(projectId)]);
		return { project: meta, state, backlog, summaries: this.summaries.get(projectId) ?? {}, head: await this.repo(projectId).head().catch(() => ""), preview: this.previews.info(projectId) };
	}

	async backlog(projectId: string): Promise<Backlog> {
		return ((await this.ws.harness.snapshot(BacklogDoc, projectId, ctx)) as Backlog | undefined) ?? emptyBacklog();
	}

	/** Mirror the project and backlog docs to `project:<ws>:<id>` subscribers (started on first subscription). */
	watch(projectId: string) {
		if (!this.#docWatches.has(projectId)) {
			const started = (async () => {
				await this.ws.harness.commit(async (tx) => {
					await tx.doc(ProjectDoc, projectId, null);
					await tx.doc(BacklogDoc, projectId, null);
				}, ctx);
				const w = await this.ws.harness.watchDoc(ProjectDoc, projectId, ctx);
				w?.start(async (value) => hub.publish(this.channel(projectId), { t: "project.state", ws: this.ws.id, project: projectId, state: value }));
				const b = await this.ws.harness.watchDoc(BacklogDoc, projectId, ctx);
				b?.start(async (value) => hub.publish(this.channel(projectId), { t: "project.backlog", ws: this.ws.id, project: projectId, backlog: value }));
			})();
			started.catch(() => this.#docWatches.delete(projectId));
			this.#docWatches.set(projectId, started);
		}
		return this.#docWatches.get(projectId)!;
	}

	// ------------------------------------------------------------------ backlog

	/** Change the backlog in one commit, then refresh docs/backlog.md on main (debounced). */
	async editBacklog<T>(projectId: string, fn: (b: Backlog) => T): Promise<T> {
		let result!: T;
		await this.ws.harness.commit(async (tx) => {
			const b = (await tx.doc(BacklogDoc, projectId, null)) as Backlog;
			result = fn(b);
			b.revision += 1;
		}, ctx);
		this.snapshotSoon(projectId);
		this.build.kick(projectId);
		return result;
	}

	readonly #snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Rewrite docs/backlog.md on main a few seconds after the last backlog change. */
	snapshotSoon(projectId: string) {
		clearTimeout(this.#snapshotTimers.get(projectId));
		this.#snapshotTimers.set(
			projectId,
			setTimeout(async () => {
				this.#snapshotTimers.delete(projectId);
				try {
					const [meta, b] = await Promise.all([this.meta(projectId), this.backlog(projectId)]);
					const repo = this.repo(projectId);
					if (await repo.writeMain("docs/backlog.md", renderBacklog(b, meta.name), `Backlog snapshot (revision ${b.revision})`))
						hub.publish(this.channel(projectId), { t: "project.repo", ws: this.ws.id, project: projectId, head: await repo.head(), files: ["docs/backlog.md"] });
				} catch (e: any) {
					console.warn(`[project ${projectId}] backlog snapshot:`, e?.message ?? e);
				}
			}, 4000),
		);
	}

	/** The user approves the backlog (Backlog tab); the Lead is told to start building. */
	async approveBacklog(projectId: string, user: User, comment?: string) {
		const rev = await this.editBacklog(projectId, (b) => {
			b.approval = Object.fromEntries(Object.entries({ ...b.approval, status: "approved", decidedBy: user.displayName, decidedAt: Date.now(), comment: comment || undefined, revision: b.revision + 1 }).filter(([, v]) => v !== undefined)) as Backlog["approval"];
			return b.revision + 1;
		});
		await this.log(projectId, { at: Date.now(), kind: "user", text: `${user.displayName} approved the backlog${comment ? `: ${clip(comment, 140)}` : ""}` });
		await this.tellLead(projectId, `The user (${user.displayName}) **approved the backlog** (revision ${rev}).${comment ? `\n\nTheir note: ${comment}` : ""}\n\nThe build starts now: pi-os assigns ready tasks to the developers (role \`worker\`), routes finished work to the reviewer and merges what passes. Make sure the team has the developers (and a reviewer) the backlog needs (team_add with start: false; they get tasks automatically). You handle blocked tasks and questions.`);
	}

	/** The user sends the backlog back with a comment; the Lead gets it to the planner. */
	async requestBacklogChanges(projectId: string, user: User, comment: string) {
		await this.editBacklog(projectId, (b) => {
			b.approval = { ...b.approval, status: "changes", decidedBy: user.displayName, decidedAt: Date.now(), comment };
		});
		await this.log(projectId, { at: Date.now(), kind: "user", text: `${user.displayName} asked for backlog changes: ${clip(comment, 160)}` });
		await this.tellLead(projectId, `The user (${user.displayName}) **requested changes to the backlog**:\n\n${comment}\n\nHave the backlog revised with the backlog tools, then request approval again with backlog_request_approval.`);
	}

	/** The user edits an item on the board (status, title, description, assignee...). */
	async updateItem(projectId: string, id: string, patch: Partial<Pick<BacklogItem, "title" | "description" | "status" | "assignee" | "estimate" | "area" | "acceptance">>, user: User) {
		const before = await this.editBacklog(projectId, (b) => {
			const item = b.items[id];
			if (!item) throw new HttpError(404, `No backlog item ${id}`);
			const old = { ...item };
			if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new HttpError(400, "Bad status");
			Object.assign(item, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { updatedAt: Date.now() });
			if (patch.assignee === "") delete item.assignee;
			return old;
		});
		if (patch.status && patch.status !== before.status) await this.log(projectId, { at: Date.now(), kind: "user", text: `${user.displayName} moved ${id} “${clip(before.title, 60)}” to ${STATUS_LABEL[patch.status]}` });
	}

	async removeItem(projectId: string, id: string, user: User) {
		const removed = await this.editBacklog(projectId, (b) => removeWithChildren(b, id));
		if (!removed.length) throw new HttpError(404, `No backlog item ${id}`);
		await this.log(projectId, { at: Date.now(), kind: "user", text: `${user.displayName} removed ${removed.join(", ")} from the backlog` });
	}

	async tellLead(projectId: string, text: string) {
		const state = await this.state(projectId);
		if (state.agents.lead && !state.agents.lead.removed) await this.deliver(projectId, "lead", { from: "pi-os", fromKey: "pi-os", text, kind: "message" });
	}

	// ------------------------------------------------------------------ lifecycle

	async create(user: User, opts: { goal: string; name?: string; model: ModelRef; files?: string[] }): Promise<ProjectMeta> {
		const goal = opts.goal.trim();
		if (goal.length < 8) throw new HttpError(400, "Describe the goal in a sentence or two");
		const id = newId("p");
		const name = opts.name?.trim() || goal.replace(/\s+/g, " ").split(/[.!?\n]/)[0]!.slice(0, 60);
		const meta: ProjectMeta = { id, name, goal, stage: "kickoff", createdAt: Date.now(), createdBy: user.displayName, model: opts.model };
		await this.repo(id).init(goal, name);
		await this.ws.harness.commit(async (tx) => {
			const all = await tx.doc(ProjectsDoc);
			all.projects[id] = meta;
			const st = (await tx.doc(ProjectDoc, id, null)) as ProjectState;
			st.activity.push({ at: Date.now(), kind: "user", text: `${user.displayName} started the project` });
		}, ctx);
		this.#publishList();
		const files = await this.attach(id, opts.files ?? [], user);
		await this.addAgent(id, {
			role: "lead",
			name: "Lead",
			brief: `Kick off the project. The user's goal:\n\n${goal}${files.length ? "\n\nThe user attached reference material: read it before deciding anything, and point teammates to the relevant files in their briefs." : ""}\n\nRoles you can add: ${roleCatalog()
				.map((r) => `\`${r.id}\` (${r.title}: ${r.summary})`)
				.join("; ")}, or any other role the goal needs.${describeFiles(files)}`,
			start: true,
			files,
		});
		return meta;
	}

	async addAgent(projectId: string, o: { role: string; name?: string; brief: string; start?: boolean; model?: ModelRef; title?: string; files?: Attached[] }): Promise<AgentRecord> {
		const meta = await this.meta(projectId);
		const repo = this.repo(projectId);
		const def = roleDef(o.role);
		const title = o.title ?? titleFor(o.role);
		const state = await this.state(projectId);
		const base = keyBase(o.role, o.role === "worker" ? undefined : o.name);
		let key = o.role === "worker" ? `${base}-1` : base;
		for (let i = 2; state.agents[key]; i++) key = `${base}-${i}`;
		const name = o.name?.trim() || (o.role === "worker" ? `Developer ${key.split("-")[1] ?? ""}`.trim() : title);
		const cwd = o.role === "lead" ? repo.main : await repo.ensureWorktree(key);
		const model = o.model ?? meta.model;
		const record: AgentRecord = { key, name, role: o.role, conversationId: "", brief: o.brief, model, createdAt: Date.now() };
		const conversation = await this.ws.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model,
					thinkingLevel: "medium",
					extensions: [this.coding, this.extension],
					...(o.role === "lead" ? {} : { tools: { remove: this.#leadOnly } }),
					instructions: agentInstructions({ role: o.role, title, key, name, project: meta, brief: o.brief, attachmentsDir: repo.attachmentsDir }),
					cwd,
				},
				init: async (tx, convId) => {
					const st = (await tx.doc(ProjectDoc, projectId, null)) as ProjectState;
					record.conversationId = String(convId);
					st.agents[key] = record;
					st.order.push(key);
					pushActivity(st, { at: Date.now(), agent: key, kind: "team", text: `${name} (${title}) joined` });
				},
			},
			ctx,
		);
		record.conversationId = String(conversation.id);
		this.#follow(projectId, record);
		this.build.kick(projectId);
		if (o.start !== false) await this.deliver(projectId, key, o.role === "lead" ? { from: "pi-os", fromKey: "pi-os", text: o.brief, kind: "brief", files: o.files } : { from: "Lead", fromKey: "lead", text: o.brief, kind: "brief" });
		return record;
	}

	/** Put a message in an agent's inbox; it runs now if idle, after its current step otherwise. */
	async deliver(projectId: string, to: string, m: { from: string; fromKey: string; text: string; kind: "brief" | "message" | "user"; files?: Attached[] }, requestId?: string) {
		const state = await this.state(projectId);
		const target = state.agents[to];
		if (!target || target.removed) throw new Error(`No agent "${to}" on this team. Use team_list.`);
		const c = await this.ws.harness.conversation(Number(target.conversationId) as any, ctx);
		if (!c) throw new Error(`Agent ${to} has no conversation`);
		const header = m.kind === "user" ? `[Message from the user, ${m.from}]` : m.kind === "brief" ? `[Brief from ${m.from}]` : `[Message from ${m.from} (${m.fromKey})]`;
		const files = m.files ?? [];
		// The kickoff brief built by create() already lists its files.
		const fileNote = m.kind === "brief" ? "" : describeFiles(files);
		await c.submit(
			{
				type: "input",
				content: `${header}\n\n${m.text}${fileNote}`,
				whenBusy: m.kind === "user" ? "steer" : "followUp",
				...(requestId ? { requestId } : {}),
				entry: { kind: "os.user", data: { author: m.kind === "user" ? m.from : `${m.from}${m.kind === "brief" ? " · brief" : ""}`, authorId: m.kind === "user" ? `user:${m.from}` : `agent:${m.fromKey}`, text: m.text, agent: m.kind !== "user", files: files.map(({ id, name, kind, mime, size }) => ({ id, name, kind, mime, size })) } },
			},
			ctx,
		);
	}

	/** The user writes to an agent from its tile; it also answers any question that agent asked. */
	async userMessage(projectId: string, key: string, user: User, text: string, fileIds: string[] = []) {
		const files = await this.attach(projectId, fileIds, user);
		if (!text.trim()) text = files.length === 1 ? `(attached ${files[0]!.name})` : `(attached ${files.length} files)`;
		await this.deliver(projectId, key, { from: user.displayName, fromKey: `user:${user.id}`, text, kind: "user", files });
		await this.ws.harness.commit(async (tx) => {
			const st = (await tx.doc(ProjectDoc, projectId, null)) as ProjectState;
			for (const q of Object.values(st.questions)) if (q.agent === key && !q.answeredAt) q.answeredAt = Date.now();
			pushActivity(st, { at: Date.now(), agent: key, kind: "user", text: `${user.displayName} → ${st.agents[key]?.name ?? key}: ${clip(text, 140)}` });
		}, ctx);
	}

	/** Store workspace uploads in the project's attachments folder (outside git) for the whole team. */
	async attach(projectId: string, fileIds: string[], user: User): Promise<Attached[]> {
		if (!fileIds.length) return [];
		const metas: Awaited<ReturnType<typeof this.ws.files.get>>[] = [];
		for (const id of fileIds.slice(0, 20)) metas.push(await this.ws.files.get(id));
		const repo = this.repo(projectId);
		const names = repo.addAttachments(metas.map((m) => ({ name: m.name, bytes: this.ws.files.all(m) })));
		const files = metas.map((m, i) => ({ id: m.id, name: names[i]!, kind: m.kind, mime: m.mime, size: m.size, path: join(repo.attachmentsDir, names[i]!) }));
		await this.ws.harness.commit(async (tx) => {
			const st = (await tx.doc(ProjectDoc, projectId, null)) as ProjectState;
			st.attachments ??= {};
			for (const [i, f] of files.entries()) st.attachments[f.name] = { name: f.name, fileId: f.id, original: metas[i]!.name, kind: f.kind, mime: f.mime, size: f.size, at: Date.now(), by: user.displayName };
			pushActivity(st, { at: Date.now(), kind: "user", text: `${user.displayName} attached ${files.map((f) => f.name).join(", ")}` });
		}, ctx);
		return files;
	}

	/** Stop every agent's current work (queued messages are withdrawn). */
	async stopAll(projectId: string) {
		const state = await this.state(projectId);
		await Promise.all(
			Object.values(state.agents).map(async (a) => {
				const c = await this.ws.harness.conversation(Number(a.conversationId) as any, ctx);
				await c?.abort(ctx).catch(() => {});
			}),
		);
		await this.log(projectId, { at: Date.now(), kind: "user", text: "All agents stopped" });
	}

	/**
	 * The user changes the project's default model (for agents added from now on), and optionally
	 * switches every current agent to it too.
	 */
	async setProjectModel(projectId: string, model: ModelRef, user: User, applyToAgents: boolean) {
		assertModel(model);
		await this.meta(projectId);
		await this.ws.harness.commit(async (tx) => {
			const all = await tx.doc(ProjectsDoc);
			all.projects[projectId]!.model = model;
			pushActivity((await tx.doc(ProjectDoc, projectId, null)) as ProjectState, { at: Date.now(), kind: "user", text: `${user.displayName} set the project model to ${model.provider}/${model.modelId}${applyToAgents ? " for every agent" : " for new agents"}` });
		}, ctx);
		if (applyToAgents) {
			const state = await this.state(projectId);
			for (const a of Object.values(state.agents)) if (!a.removed) await this.#setAgentModel(projectId, a, model);
		}
		this.#publishList();
		hub.publish(this.channel(projectId), { t: "project.meta", ws: this.ws.id, project: projectId });
	}

	/** The user switches one agent's model; it applies from the agent's next model request. */
	async setAgentModel(projectId: string, key: string, model: ModelRef, user: User) {
		assertModel(model);
		const a = (await this.state(projectId)).agents[key];
		if (!a || a.removed) throw new HttpError(404, `No agent ${key}`);
		await this.#setAgentModel(projectId, a, model);
		await this.log(projectId, { at: Date.now(), agent: key, kind: "user", text: `${user.displayName} switched ${a.name} to ${model.provider}/${model.modelId}` });
	}

	async #setAgentModel(projectId: string, a: AgentRecord, model: ModelRef) {
		const c = await this.ws.harness.conversation(Number(a.conversationId) as any, ctx);
		await c?.configure({ model }, ctx);
		await this.ws.harness.commit(async (tx) => {
			const st = (await tx.doc(ProjectDoc, projectId, null)) as ProjectState;
			if (st.agents[a.key]) st.agents[a.key]!.model = model;
		}, ctx);
	}

	async archive(projectId: string) {
		await this.stopAll(projectId);
		await this.previews.stop(projectId);
		await this.ws.harness.commit(async (tx) => {
			const all = await tx.doc(ProjectsDoc);
			if (all.projects[projectId]) all.projects[projectId]!.archived = true;
		}, ctx);
		const state = await this.state(projectId);
		for (const a of Object.values(state.agents)) {
			this.#watchers.get(a.conversationId)?.stop();
			this.#watchers.delete(a.conversationId);
		}
		this.#publishList();
	}

	// ------------------------------------------------------------------ internals

	#follow(projectId: string, a: AgentRecord) {
		this.#byConversation.set(a.conversationId, { projectId, key: a.key });
		if (this.#watchers.has(a.conversationId)) return;
		const w = new AgentWatcher(this.ws.harness, a.conversationId, (summary) => {
			const all = this.summaries.get(projectId) ?? {};
			const wasBusy = all[a.key]?.busy;
			all[a.key] = summary;
			if (wasBusy && !summary.busy) setTimeout(() => void this.build.agentIdle(projectId, a.key).catch((e) => console.warn(`[build ${projectId}] idle ${a.key}:`, e?.message ?? e)), 800);
			this.summaries.set(projectId, all);
			hub.publish(this.channel(projectId), { t: "project.agent", ws: this.ws.id, project: projectId, key: a.key, summary });
		});
		this.#watchers.set(a.conversationId, w);
		w.start().catch((e) => console.warn(`[project ${projectId}] watch ${a.key} failed:`, e?.message ?? e));
	}

	#publishList() {
		hub.publish(this.ws.channel, { t: "ws.projects", ws: this.ws.id });
	}

	/** Main moved (a merge or publish): the preview restarts if the app changed. */
	mainChanged(projectId: string, files: string[]) {
		this.previews.mainChanged(projectId, files);
	}

	async setStage(projectId: string, stage: ProjectStage, note?: string, agent?: string) {
		await this.ws.harness.commit(async (tx) => {
			const all = await tx.doc(ProjectsDoc);
			if (all.projects[projectId]) all.projects[projectId]!.stage = stage;
			pushActivity((await tx.doc(ProjectDoc, projectId, null)) as ProjectState, { at: Date.now(), ...(agent ? { agent } : {}), kind: "stage", text: `Stage: ${stage}${note ? ` — ${note}` : ""}` });
		}, ctx);
		this.#publishList();
		hub.publish(this.channel(projectId), { t: "project.meta", ws: this.ws.id, project: projectId });
	}

	async log(projectId: string, entry: Activity) {
		if (entry.agent === undefined) delete entry.agent;
		await this.ws.harness.commit(async (tx) => pushActivity((await tx.doc(ProjectDoc, projectId, null)) as ProjectState, entry), ctx);
	}

	async #caller(api: ToolExecutionApi) {
		const who = this.#byConversation.get(String(api.conversationId));
		if (!who) throw new Error("These tools only work for project agents.");
		const state = await this.state(who.projectId);
		const me = state.agents[who.key]!;
		return { ...who, me, state };
	}

	#tools() {
		return [
			defineTool({
				name: "team_list",
				description: "Who is on the team: key, name, role, and what each is doing right now.",
				parameters: Type.Object({}),
				execute: async (_args, api) => {
					const { projectId, state, key } = await this.#caller(api);
					const sums = this.summaries.get(projectId) ?? {};
					return text(
						state.order
							.map((k) => state.agents[k]!)
							.filter((a) => !a.removed)
							.map((a) => ({ key: a.key, name: a.name, role: a.role, you: a.key === key || undefined, status: sums[a.key]?.status ?? "idle", doing: sums[a.key]?.activity })),
					);
				},
			}),
			defineTool({
				name: "message",
				description: "Send a message to a teammate by key (e.g. \"lead\"). It wakes them up, so only send what they need to act on.",
				parameters: Type.Object({ to: Type.String({ description: "agent key" }), text: Type.String() }),
				replay: "safe",
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					if (args.to === me.key) throw new Error("That's you.");
					await this.deliver(projectId, args.to, { from: me.name, fromKey: me.key, text: args.text, kind: "message" }, `msg:${api.taskId}`);
					await this.log(projectId, { at: Date.now(), agent: me.key, kind: "message", text: `${me.name} → ${args.to}: ${clip(args.text, 140)}` });
					return text(`Delivered to ${args.to}.`);
				},
			}),
			defineTool({
				name: "ask_user",
				description: "Ask the user a question only they can answer. It shows on your tile and in the project's activity. End your turn after asking; the answer arrives as a message.",
				parameters: Type.Object({ question: Type.String() }),
				replay: "safe",
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					await this.ws.harness.commit(async (tx) => {
						const st = (await tx.doc(ProjectDoc, projectId, null)) as ProjectState;
						const id = `q_${api.taskId}`;
						if (st.questions[id]) return;
						st.questions[id] = { id, agent: me.key, text: args.question, at: Date.now() };
						pushActivity(st, { at: Date.now(), agent: me.key, kind: "question", text: `${me.name} asks: ${clip(args.question, 160)}` });
					}, ctx);
					return { ...text("Question posted to the user. End your turn now; their answer will arrive as a message."), control: { terminate: true } };
				},
			}),
			defineTool({
				name: "publish",
				description: "Commit everything in your worktree and merge it into main, where the user and the team see it.",
				parameters: Type.Object({ message: Type.String({ description: "commit message: what this adds or changes" }) }),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					if (me.role === "lead") throw new Error("The lead works in main directly and doesn't publish; ask a teammate to make changes.");
					const held = await this.build.heldBy(projectId, me.key);
					if (held.working) throw new Error(`You're working on ${held.working.id}: call task_done when it's complete. pi-os reviews and merges task work; don't publish it.`);
					if (await this.repo(projectId).isDetached(me.key))
						throw new Error(held.reviewing.length ? `Your worktree holds ${held.reviewing.map((t) => t.id).join(", ")} for review; you can't publish from it. Call review_verdict.` : `Your worktree is detached from your branch; run \`git checkout agent/${me.key}\` first.`);
					const r = await this.repo(projectId).publish(me.key, args.message);
					if (r.conflict) return text(r.conflict);
					if (!r.merged) return text("Nothing new to publish: your branch has no changes that main doesn't already have.");
					await this.log(projectId, { at: Date.now(), agent: me.key, kind: "publish", text: `${me.name} published “${clip(args.message, 100)}” (${r.files.length} file${r.files.length === 1 ? "" : "s"})` });
					hub.publish(this.channel(projectId), { t: "project.repo", ws: this.ws.id, project: projectId, head: r.commit, files: r.files });
					this.mainChanged(projectId, r.files);
					return text(`Merged into main as ${r.commit}: ${r.files.join(", ")}`);
				},
			}),
			defineTool({
				name: "sync_main",
				description: "Merge the latest main into your worktree to pick up what teammates published.",
				parameters: Type.Object({}),
				execute: async (_args, api) => {
					const { projectId, me } = await this.#caller(api);
					if (me.role === "lead") return text("You work in main; it is always current.");
					return text(await this.repo(projectId).sync(me.key));
				},
			}),
			defineTool({
				name: "team_add",
				description: "Lead only. Add an agent to the team. With start (default true) it receives the brief and begins at once; with start=false it waits until you message it.",
				parameters: Type.Object({
					role: Type.String({ description: `a known role (${roleCatalog()
						.map((r) => r.id)
						.join(", ")}) or any other role name` }),
					name: Type.Optional(Type.String({ description: "display name, e.g. \"Frontend dev\"" })),
					brief: Type.String({ description: "everything they need: goal, what to produce, where, constraints, who to report to" }),
					start: Type.Optional(Type.Boolean()),
					model: Type.Optional(Type.String({ description: "provider/modelId; default: the project's model" })),
				}),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					if (me.role !== "lead") throw new Error("Only the lead adds agents.");
					const a = await this.addAgent(projectId, { role: args.role, name: args.name, brief: args.brief, start: args.start, model: parseModel(args.model) });
					return text(`Added ${a.name} as \`${a.key}\`${args.start === false ? " (waiting; message them to start)" : " — briefed and working"}.`);
				},
			}),
			defineTool({
				name: "set_stage",
				description: `Lead only. Move the project to a stage the user sees: ${STAGES.join(", ")}.`,
				parameters: Type.Object({ stage: Type.String(), note: Type.Optional(Type.String()) }),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					if (me.role !== "lead") throw new Error("Only the lead sets the stage.");
					if (!STAGES.includes(args.stage as ProjectStage)) throw new Error(`Unknown stage. Use one of: ${STAGES.join(", ")}`);
					await this.setStage(projectId, args.stage as ProjectStage, args.note, me.key);
					return text(`Stage is now ${args.stage}.`);
				},
			}),
			...this.#backlogTools(),
			...this.#buildTools(),
		];
	}

	#buildTools() {
		return [
			defineTool({
				name: "task_done",
				description: "Developers: hand in the task you're working on. pi-os commits your branch (with the latest main merged in), has it reviewed, and merges it into main. End your turn after it.",
				parameters: Type.Object({
					summary: Type.String({ description: "what you did and how you tested it, in a few lines" }),
					no_changes: Type.Optional(Type.Boolean({ description: "true only if the task needed no code change (say why in the summary)" })),
				}),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					const out = await this.build.taskDone(projectId, me, args.summary, !!args.no_changes);
					return out.startsWith("Submitted") ? { ...text(out), control: { terminate: true } } : text(out);
				},
			}),
			defineTool({
				name: "task_blocked",
				description: "Developers: you can't finish your task (missing decision, broken dependency, unclear requirement). The task is marked blocked and the lead gets your reason. End your turn after it.",
				parameters: Type.Object({ reason: Type.String({ description: "what's in the way and what you need" }) }),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					return { ...text(await this.build.taskBlocked(projectId, me, args.reason)), control: { terminate: true } };
				},
			}),
			defineTool({
				name: "review_verdict",
				description: "Reviewers: your verdict on a task pi-os gave you to review. approve: pi-os merges it into main; changes: it goes back to the developer with your notes. End your turn after it.",
				parameters: Type.Object({
					task: Type.String({ description: "task id, e.g. T4" }),
					verdict: Type.Union([Type.Literal("approve"), Type.Literal("changes")]),
					notes: Type.String({ description: "changes: concrete, actionable findings; approve: optional remarks" }),
				}),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					return { ...text(await this.build.verdict(projectId, me, args.task, args.verdict, args.notes)), control: { terminate: true } };
				},
			}),
			defineTool({
				name: "preview",
				description: "The live preview: pi-os runs the app from main (per .pios/project.json) and shows it in the App tab. Get its status and recent logs, or restart it after fixing the run config.",
				parameters: Type.Object({ action: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("restart")])) }),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					const info = args.action === "restart" ? await this.previews.start(projectId, `restart by ${me.name}`) : this.previews.info(projectId);
					const where = info.port ? ` at http://${info.host ?? "127.0.0.1"}:${info.port}` : "";
					return text(`Preview: ${info.status}${where}${info.head ? ` (main @ ${info.head})` : ""}${info.error ? `\n${info.error}` : ""}\n\nRecent logs:\n${this.previews.tail(projectId) || "(none)"}`);
				},
			}),
		];
	}

	#backlogTools() {
		const ItemInput = Type.Object({
			ref: Type.Optional(Type.String({ description: "your local name for this item, so later items in the same call can use it as parent or dependency" })),
			type: Type.Union([Type.Literal("feature"), Type.Literal("pbi"), Type.Literal("task")]),
			parent: Type.Optional(Type.String({ description: "PBIs: their feature; tasks: their PBI. An id (F1, P2) or a ref from this call" })),
			title: Type.String(),
			description: Type.Optional(Type.String({ description: "markdown" })),
			acceptance: Type.Optional(Type.Array(Type.String(), { description: "PBIs: acceptance criteria, one per entry" })),
			deps: Type.Optional(Type.Array(Type.String(), { description: "items (ids or refs) that must be done first" })),
			area: Type.Optional(Type.String({ description: "tasks: the part of app/ they touch, e.g. app/src/api" })),
			estimate: Type.Optional(Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L")])),
		});
		return [
			defineTool({
				name: "backlog_add",
				description:
					"Add backlog items: features → PBIs (with acceptance criteria) → tasks (one developer, one sitting; with dependencies and area). Add many in one call; use `ref` to link items created in the same call. Returns their ids.",
				parameters: Type.Object({ items: Type.Array(ItemInput, { minItems: 1, maxItems: 200 }) }),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					const created = await this.editBacklog(projectId, (b) => addItems(b, args.items as ItemInput[], me.key));
					await this.log(projectId, { at: Date.now(), agent: me.key, kind: "team", text: `${me.name} added ${created.length} backlog item${created.length === 1 ? "" : "s"}` });
					return text(created.map((c) => `${c.id} ${c.title}${c.parent ? ` (under ${c.parent})` : ""}`).join("\n"));
				},
			}),
			defineTool({
				name: "backlog_update",
				description: "Change a backlog item: its status (todo, doing, review, done, blocked), assignee (agent key), title, description, acceptance criteria, dependencies, area, estimate or parent. Keep the status of your own tasks current.",
				parameters: Type.Object({
					id: Type.String(),
					status: Type.Optional(Type.Union(STATUSES.map((s) => Type.Literal(s)))),
					assignee: Type.Optional(Type.String({ description: "agent key, or empty to unassign" })),
					title: Type.Optional(Type.String()),
					description: Type.Optional(Type.String()),
					acceptance: Type.Optional(Type.Array(Type.String())),
					deps: Type.Optional(Type.Array(Type.String())),
					area: Type.Optional(Type.String()),
					estimate: Type.Optional(Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L")])),
					parent: Type.Optional(Type.String()),
				}),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					const moved = await this.editBacklog(projectId, (b) => {
						const item = b.items[args.id];
						if (!item) throw new Error(`No backlog item ${args.id}. Use backlog_list.`);
						if (item.type === "task" && me.role !== "lead" && b.approval.status === "approved" && (args.status === "review" || args.status === "done") && item.status !== args.status)
							throw new Error("Tasks reach review and done through pi-os: the developer calls task_done, the reviewer review_verdict.");
						const was = item.status;
						if (args.parent !== undefined) {
							if (b.items[args.parent]?.type !== PARENT_TYPE[item.type]) throw new Error(`A ${item.type}'s parent must be an existing ${PARENT_TYPE[item.type] ?? "(none)"}`);
							item.parent = args.parent;
						}
						if (args.deps) {
							const missing = args.deps.filter((d) => !b.items[d]);
							if (missing.length) throw new Error(`Unknown dependencies: ${missing.join(", ")}`);
							item.deps = args.deps.filter((d) => d !== item.id);
						}
						if (args.assignee !== undefined) {
							if (args.assignee) item.assignee = args.assignee;
							else delete item.assignee;
						}
						for (const k of ["status", "title", "description", "acceptance", "area", "estimate"] as const) if (args[k] !== undefined) (item as any)[k] = args[k];
						item.updatedAt = Date.now();
						return was !== item.status ? `${item.id} “${clip(item.title, 60)}” → ${STATUS_LABEL[item.status]}` : undefined;
					});
					if (moved) await this.log(projectId, { at: Date.now(), agent: me.key, kind: "team", text: `${me.name} moved ${moved}` });
					return text(`Updated ${args.id}.`);
				},
			}),
			defineTool({
				name: "backlog_remove",
				description: "Remove a backlog item and everything under it (a feature's PBIs and their tasks).",
				parameters: Type.Object({ id: Type.String() }),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					const removed = await this.editBacklog(projectId, (b) => removeWithChildren(b, args.id));
					if (!removed.length) throw new Error(`No backlog item ${args.id}.`);
					await this.log(projectId, { at: Date.now(), agent: me.key, kind: "team", text: `${me.name} removed ${removed.join(", ")} from the backlog` });
					return text(`Removed ${removed.join(", ")}.`);
				},
			}),
			defineTool({
				name: "backlog_list",
				description: "The backlog as an outline: features, PBIs with acceptance criteria, tasks with status, assignee, estimate, dependencies and area; plus the approval state.",
				parameters: Type.Object({}),
				execute: async (_args, api) => {
					const { projectId } = await this.#caller(api);
					return text(backlogOutline(await this.backlog(projectId)));
				},
			}),
			defineTool({
				name: "backlog_request_approval",
				description:
					"Lead or planner: submit the backlog for the user's approval. They review it as a board in the Backlog tab and approve or request changes; you'll get their decision as a message. Don't start the build before approval, and don't also ask with ask_user.",
				parameters: Type.Object({ summary: Type.String({ description: "a few lines: scope, how many features/PBIs/tasks, how the work splits across developers, open points" }) }),
				execute: async (args, api) => {
					const { projectId, me } = await this.#caller(api);
					if (!["lead", "planner"].includes(me.role)) throw new Error("Only the lead or the planner requests backlog approval.");
					const n = await this.editBacklog(projectId, (b) => {
						const tasks = Object.values(b.items).filter((i) => i.type === "task").length;
						if (!tasks) throw new Error("The backlog has no tasks yet. Add them with backlog_add first.");
						b.approval = { status: "pending", summary: args.summary, requestedBy: me.name, requestedAt: Date.now() };
						return tasks;
					});
					await this.log(projectId, { at: Date.now(), agent: me.key, kind: "question", text: `${me.name} asks you to approve the backlog (${n} tasks) — see the Backlog tab` });
					return { ...text("Submitted. The user reviews it in the Backlog tab; their decision arrives as a message. End your turn now."), control: { terminate: true } };
				},
			}),
		];
	}
}

/** Remove an item, everything under it, and dependencies on any of them. Returns the removed ids. */
function removeWithChildren(b: Backlog, id: string): string[] {
	if (!b.items[id]) return [];
	const gone = new Set([id]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const i of Object.values(b.items)) if (i.parent && gone.has(i.parent) && !gone.has(i.id)) (gone.add(i.id), (grew = true));
	}
	for (const g of gone) delete b.items[g];
	for (const i of Object.values(b.items)) i.deps = i.deps.filter((d) => !gone.has(d));
	return [...gone];
}

/** Reject models pi-os doesn't know (typos, a provider that was removed). */
function assertModel(m: ModelRef) {
	if (!m?.provider || !m?.modelId || !modelRegistry.getModel(m.provider, m.modelId)) throw new HttpError(400, `Unknown model ${m?.provider}/${m?.modelId}`);
}

const titleFor = (role: string) => roleDef(role)?.title ?? role.replace(/(^|-)(\w)/g, (_m, s, c) => `${s ? " " : ""}${c.toUpperCase()}`);

function pushActivity(st: ProjectState, a: Activity) {
	st.activity.push(a);
	if (st.activity.length > ACTIVITY_LIMIT) st.activity.splice(0, st.activity.length - ACTIVITY_LIMIT);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
