import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { hub } from "../collab/hub.ts";
import { HttpError, newId, type User } from "../kernel/system-db.ts";
import { formatBytes } from "../files/store.ts";
import type { Workspace } from "../kernel/workspace.ts";
import { ACTIVITY_LIMIT, ProjectDoc, ProjectsDoc, type Activity, type AgentRecord, type ProjectMeta, type ProjectStage, type ProjectState } from "./docs.ts";
import { ProjectRepo } from "./repo.ts";
import { join } from "node:path";
import { agentInstructions, roleCatalog, roleDef } from "./roles.ts";
import { AgentWatcher, type AgentSummary } from "./watch.ts";

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

	constructor(readonly ws: Workspace) {
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
			for (const a of Object.values(state.agents)) if (!a.removed) this.#follow(p.id, a);
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
		const [meta, state] = await Promise.all([this.meta(projectId), this.state(projectId)]);
		return { project: meta, state, summaries: this.summaries.get(projectId) ?? {}, head: await this.repo(projectId).head().catch(() => "") };
	}

	/** Mirror the project doc to `project:<ws>:<id>` subscribers (started on first subscription). */
	watch(projectId: string) {
		if (!this.#docWatches.has(projectId)) {
			const started = (async () => {
				await this.ws.harness.commit(async (tx) => void (await tx.doc(ProjectDoc, projectId, null)), ctx);
				const w = await this.ws.harness.watchDoc(ProjectDoc, projectId, ctx);
				w?.start(async (value) => hub.publish(this.channel(projectId), { t: "project.state", ws: this.ws.id, project: projectId, state: value }));
			})();
			started.catch(() => this.#docWatches.delete(projectId));
			this.#docWatches.set(projectId, started);
		}
		return this.#docWatches.get(projectId)!;
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
		const title = o.title ?? def?.title ?? o.role.replace(/(^|-)(\w)/g, (_m, s, c) => `${s ? " " : ""}${c.toUpperCase()}`);
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
		await this.#log(projectId, { at: Date.now(), kind: "user", text: "All agents stopped" });
	}

	async archive(projectId: string) {
		await this.stopAll(projectId);
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
			all[a.key] = summary;
			this.summaries.set(projectId, all);
			hub.publish(this.channel(projectId), { t: "project.agent", ws: this.ws.id, project: projectId, key: a.key, summary });
		});
		this.#watchers.set(a.conversationId, w);
		w.start().catch((e) => console.warn(`[project ${projectId}] watch ${a.key} failed:`, e?.message ?? e));
	}

	#publishList() {
		hub.publish(this.ws.channel, { t: "ws.projects", ws: this.ws.id });
	}

	async #log(projectId: string, entry: Activity) {
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
					await this.#log(projectId, { at: Date.now(), agent: me.key, kind: "message", text: `${me.name} → ${args.to}: ${clip(args.text, 140)}` });
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
					const r = await this.repo(projectId).publish(me.key, args.message);
					if (r.conflict) return text(r.conflict);
					if (!r.merged) return text("Nothing new to publish: your branch has no changes that main doesn't already have.");
					await this.#log(projectId, { at: Date.now(), agent: me.key, kind: "publish", text: `${me.name} published “${clip(args.message, 100)}” (${r.files.length} file${r.files.length === 1 ? "" : "s"})` });
					hub.publish(this.channel(projectId), { t: "project.repo", ws: this.ws.id, project: projectId, head: r.commit, files: r.files });
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
					await this.ws.harness.commit(async (tx) => {
						const all = await tx.doc(ProjectsDoc);
						if (all.projects[projectId]) all.projects[projectId]!.stage = args.stage as ProjectStage;
						pushActivity((await tx.doc(ProjectDoc, projectId, null)) as ProjectState, { at: Date.now(), agent: me.key, kind: "stage", text: `Stage: ${args.stage}${args.note ? ` — ${args.note}` : ""}` });
					}, ctx);
					this.#publishList();
					hub.publish(this.channel(projectId), { t: "project.meta", ws: this.ws.id, project: projectId });
					return text(`Stage is now ${args.stage}.`);
				},
			}),
		];
	}
}

function pushActivity(st: ProjectState, a: Activity) {
	st.activity.push(a);
	if (st.activity.length > ACTIVITY_LIMIT) st.activity.splice(0, st.activity.length - ACTIVITY_LIMIT);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
