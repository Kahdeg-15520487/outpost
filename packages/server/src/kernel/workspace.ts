import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, watchEvents, type Conversation, type Extension } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { config } from "../config.ts";
import { hub } from "../collab/hub.ts";
import { createOutpostExtension } from "../agent/extension.ts";
import { ModuleHost, type Caller } from "../modules/host.ts";
import { AIRLOCKS, type Airlock } from "../airlocks/catalog.ts";
import { Connections } from "../airlocks/connectors/index.ts";
import { holds } from "../airlocks/prompt.ts";
import { FileStore, formatBytes, imageProcessor, looksLikeText } from "../files/store.ts";
import { buildFrame } from "../modules/frame.ts";
import { renderModule, type RenderAction } from "../modules/render.ts";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import {
	ApprovalsDoc,
	AuditDoc,
	ChatsDoc,
	FilesDoc,
	ModuleLogsDoc,
	ModuleSourceDoc,
	ModuleStateDoc,
	GrantsDoc,
	MailboxDoc,
	type AccessRequest,
	type ApprovalAction,
	type AuditLine,
	type FileMeta,
	type Grant,
	type Holder,
} from "./docs.ts";
import { defaultModel, models } from "./models.ts";
import { watchRuns, watchRunning } from "./home.ts";
import { backfillModuleChats } from "./module-chats.ts";
import { MissionManager } from "../missions/manager.ts";
import { agentEnv } from "../missions/env.ts";
import { blueprints, modules, HttpError, newId, users, workspaces, type BlueprintRow, type ModuleRow, type User, type WorkspaceRow } from "./system-db.ts";

const open = new Map<string, Promise<Workspace>>();
const codemodeSandbox = new CodemodeSandbox({ memoryLimitBytes: 128 * 1024 * 1024 });

/**
 * One workspace = one pi-durable Harness over its own SQLite file. Chats are conversations, module
 * code/state/logs and Airlock grants/approvals are documents in it. Everything is committed
 * before it is shown, and unfinished agent runs continue after a restart (`harness.resume()`).
 */
export class Workspace {
	readonly hosts = new Map<string, ModuleHost>();
	readonly channel: string;
	readonly files: FileStore;
	/** Agent teams (missions) in this workspace. */
	missions!: MissionManager;
	/** Third-party services (MCP servers, REST APIs) this workspace can grant access to. */
	connections!: Connections;
	private constructor(
		readonly id: string,
		readonly harness: Harness,
	) {
		this.channel = `ws:${id}`;
		this.files = new FileStore(harness, config.workspaceDir, id);
	}

	get row(): WorkspaceRow {
		return workspaces.get(this.id)!;
	}

	static get(id: string): Promise<Workspace> {
		let ws = open.get(id);
		if (!ws) {
			if (!workspaces.get(id)) throw new HttpError(404, "No such workspace");
			ws = Workspace.#open(id);
			open.set(id, ws);
			ws.catch(() => open.delete(id));
		}
		return ws;
	}

	/** Close one workspace (its next Workspace.get reopens it, like a restart). */
	static async close(id: string) {
		const p = open.get(id);
		open.delete(id);
		const ws = await p?.catch(() => undefined);
		ws?.missions?.stop();
		await ws?.connections?.close().catch(() => {});
		await ws?.harness.close(ctx).catch(() => {});
	}

	static async closeAll() {
		for (const p of open.values()) {
			const ws = await p.catch(() => undefined);
			ws?.missions?.stop();
			await ws?.connections?.close().catch(() => {});
			await ws?.harness.close(ctx).catch(() => {});
		}
	}

	static async #open(id: string): Promise<Workspace> {
		const registry = createRegistry();
		const storage = await openNodeSqliteStorage(join(config.workspaceDir, `${id}.sqlite`));
		let self: Workspace | undefined;
		// Chats keep exactly the OS + code mode extensions; mission agents select coding tools + mission tools.
		let chatExtensions: Extension[] | undefined;
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				identity: { attribution: { name: "Outpost", url: "https://github.com/Kahdeg-15520487/outpost" } },
				// Mission agents' file/bash tools run in their own worktree (their agent `cwd`).
				// (Git Bash paths translated; file writes confined to the worktree — see missions/env.ts.)
				env: ({ cwd }) => (cwd ? agentEnv(cwd) : new NodeExecutionEnv({ cwd: config.dataDir })),
				settings: () => ({
					extensions: chatExtensions,
					toolExecution: "parallel",
					stream: { timeoutMs: 180_000 },
					retry: { maxRetries: 3 },
					progress: { partialIntervalMs: 80, outputIntervalMs: 120 },
					afterFailedRun: "continue",
				}),
				onReport: (error, info) => console.warn(`[ws ${id}] ${info.type}`, (info as any).task?.kind ?? "", error instanceof Error ? error.message : error),
			},
			ctx,
		);
		const ws = (self = new Workspace(id, harness));
		ws.connections = new Connections(id, harness, () => hub.publish(ws.channel, { t: "ws.connections", ws: id }));
		const outpostExtension = createOutpostExtension(ws);
		const codemode = createCodemodeExtension({ sandbox: codemodeSandbox, models: false });
		registry.install(outpostExtension);
		registry.install(codemode);
		chatExtensions = [outpostExtension, codemode];
		ws.missions = new MissionManager(ws);
		registry.install(ws.missions.coding);
		registry.install(ws.missions.extension);
		await ws.#watchDocs();
		await backfillModuleChats(ws);
		await ws.missions.init();
		harness.closed.then((end) => {
			if (end.reason === "failed") {
				console.error(`[ws ${id}] harness failed, will reopen on next use`, end.error);
				open.delete(id);
			}
		});
		harness.resume(); // pick up runs a previous process left unfinished
		void watchRunning(ws); // …and record what those resumed runs do
		return self;
	}

	/** Mirror workspace documents to subscribers of `ws:<id>`. Docs are created first: watchDoc only attaches to existing ones. */
	async #watchDocs() {
		const docs = { chats: ChatsDoc, grants: GrantsDoc, approvals: ApprovalsDoc, audit: AuditDoc, mailbox: MailboxDoc, files: FilesDoc } as const;
		await this.harness.commit(async (tx) => {
			for (const token of Object.values(docs)) await tx.doc(token as any);
		}, ctx);
		for (const [name, token] of Object.entries(docs)) {
			const watch = await this.harness.watchDoc(token as any, ctx);
			watch?.start(async (value) => hub.publish(this.channel, { t: "ws.doc", ws: this.id, name, value }));
		}
	}

	async snapshot() {
		const [chats, grants, approvals, audit, mailbox, files] = await Promise.all([
			this.harness.snapshot(ChatsDoc, ctx),
			this.harness.snapshot(GrantsDoc, ctx),
			this.harness.snapshot(ApprovalsDoc, ctx),
			this.harness.snapshot(AuditDoc, ctx),
			this.harness.snapshot(MailboxDoc, ctx),
			this.harness.snapshot(FilesDoc, ctx),
		]);
		return {
			chats: chats ?? { chats: {} },
			grants: grants ?? { grants: {}, requests: {} },
			approvals: approvals ?? { actions: {} },
			audit: audit ?? { lines: [] },
			mailbox: mailbox ?? { sent: [] },
			files: files ?? { files: {} },
		};
	}

	publishModules() {
		hub.publish(this.channel, { t: "ws.modules", ws: this.id });
	}

	// ------------------------------------------------------------------ chats

	async createChat(user: User, title?: string, model?: { provider: string; modelId: string }): Promise<string> {
		const settings = this.row.settings;
		const chosen = model ?? (await defaultModel(settings.defaultModel, users.prefs(user.id).modelPicker));
		const conversation = await this.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: chosen, thinkingLevel: "medium" },
				init: async (tx, id) => {
					const chats = await tx.doc(ChatsDoc);
					chats.chats[String(id)] = { id: String(id), title: title?.trim() || "New chat", createdAt: Date.now(), createdBy: user.displayName, updatedAt: Date.now(), moduleIds: [] };
				},
			},
			ctx,
		);
		if (settings.toolMode === "codemode") await this.#codemodeOnly(conversation);
		return String(conversation.id);
	}

	async #codemodeOnly(conversation: Conversation) {
		const agent = await conversation.agent(ctx);
		const codemode = agent.tools.find((t) => t.name === "codemode");
		const keep = agent.tools.filter((t) => ["codemode", "module_write", "module_edit", "subagent"].includes(t.name));
		if (codemode) await conversation.configure({ modelTools: keep }, ctx);
	}

	async conversation(id: string): Promise<Conversation> {
		const c = await this.harness.conversation(Number(id) as any, ctx);
		if (!c) throw new HttpError(404, "No such chat");
		return c;
	}

	async send(chatId: string, user: User, content: string, mode: "followUp" | "steer" = "followUp", fileIds: string[] = [], moduleId?: string) {
		const c = await this.conversation(chatId);
		// Follow the run from the start — and before submitting, so a fast run can't end unrecorded. It may
		// well finish while nobody has the chat open; that is exactly what the homepage reports on.
		await watchRuns(this, chatId).catch(() => {});
		const attached: FileMeta[] = [];
		for (const id of fileIds) attached.push(await this.files.get(id));
		for (const f of attached) if (!f.chatId) await this.files.update(f.id, (m) => void (m.chatId = chatId));
		if (!content.trim() && attached.length) content = attached.length === 1 ? `(attached ${attached[0]!.name})` : `(attached ${attached.length} files)`;
		// The user typed this with a module open beside the chat: "this deck", "the board", "it" mean that module.
		const open = moduleId ? modules.get(moduleId) : undefined;
		const focus = open?.workspaceId === this.id ? `[outpost: the user has module ${open.id} "${open.name}"${open.blueprintId ? ` (from blueprint ${open.blueprintId})` : ""} open next to this chat. Unless they say otherwise, "this", "it" and the like refer to that module — use the module tools on it, and read its API first.]\n\n` : "";
		await this.harness.commit(async (tx) => {
			const chats = await tx.doc(ChatsDoc);
			const chat = chats.chats[chatId];
			if (chat) {
				if (open?.workspaceId === this.id) {
					chat.moduleIds ??= [];
					if (!chat.moduleIds.includes(open.id)) chat.moduleIds.push(open.id);
				}
				chat.updatedAt = Date.now();
				if (chat.title === "New chat") chat.title = content.replace(/\s+/g, " ").slice(0, 60);
			}
		}, ctx);
		// Every member sees the same transcript; mark who said what.
		const submission = await c.submit(
			{
				type: "input",
				content: attached.length ? [{ type: "text", text: focus + content }, ...(await this.#attachmentParts(attached))] : focus + content,
				whenBusy: mode === "steer" ? "steer" : "followUp",
				entry: {
					kind: "outpost.user",
					data: { author: user.displayName, authorId: user.id, text: content, ...(open?.workspaceId === this.id ? { moduleId: open.id } : {}), files: attached.map((f) => ({ id: f.id, name: f.name, kind: f.kind, mime: f.mime, size: f.size })) },
				},
			},
			ctx,
		);
		return submission.id;
	}

	/** What the model sees for each attachment: images inline, small text inline, everything else as a handle for the file tools. */
	async #attachmentParts(files: FileMeta[]) {
		const parts: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
		for (const f of files) {
			const label = `[Attached file ${f.id}: "${f.name}" — ${f.kind}, ${f.mime}, ${formatBytes(f.size)}]`;
			const image = await this.files.image(f).catch(() => undefined);
			if (image) {
				parts.push({ type: "text", text: `${label}${image.note ? ` (shown ${image.note})` : ""}` }, { type: "image", data: image.data, mimeType: image.mimeType });
				continue;
			}
			const head = this.files.bytes(f, 0, 24_000);
			if (looksLikeText(head) && f.size <= 24_000) parts.push({ type: "text", text: `${label}\n<file name="${f.name}">\n${head.toString("utf8")}\n</file>` });
			else parts.push({ type: "text", text: `${label} Not inlined — inspect it with the file tools (file_info first).` });
		}
		return parts;
	}

	/** Record actual work on a module, resolving subagent conversations to their owning chat. */
	async linkModuleChat(conversationId: string, moduleId: string) {
		await this.harness.commit(async (tx) => {
			if (modules.get(moduleId)?.workspaceId !== this.id) return;
			const chats = (await tx.doc(ChatsDoc)).chats;
			let id = conversationId;
			for (let depth = 0; depth < 16; depth++) {
				const chat = chats[id];
				if (chat) {
					chat.moduleIds ??= [];
					if (!chat.moduleIds.includes(moduleId)) chat.moduleIds.push(moduleId);
					return;
				}
				const record = await tx.conversation(Number(id) as any);
				if (!record?.owner) return;
				id = String(record.owner.conversationId);
			}
		}, ctx);
	}

	async renameChat(chatId: string, title: string) {
		await this.harness.commit(async (tx) => {
			const chat = (await tx.doc(ChatsDoc)).chats[chatId];
			if (chat) chat.title = title.slice(0, 120);
		}, ctx);
	}

	async archiveChat(chatId: string) {
		await (await this.conversation(chatId)).abort(ctx).catch(() => {});
		await this.harness.commit(async (tx) => {
			const chat = (await tx.doc(ChatsDoc)).chats[chatId];
			if (chat) chat.archived = true;
		}, ctx);
	}

	watchEvents(chatId: string) {
		return watchEvents(this.harness, Number(chatId) as any, ctx);
	}

	// ------------------------------------------------------------------ modules

	host(moduleId: string): ModuleHost {
		let host = this.hosts.get(moduleId);
		if (!host) {
			host = new ModuleHost(moduleId, {
				harness: this.harness,
				files: this.files,
				name: () => modules.get(moduleId)?.name ?? moduleId,
				airlock: (gid, grant, method, args, caller) =>
					this.airlockCall({ kind: "module", id: gid }, grant, method, args, { kind: "module", id: gid, name: `${modules.get(gid)?.name ?? gid} (${caller.name})` }),
			});
			this.hosts.set(moduleId, host);
		}
		return host;
	}

	/** Render a module's client headlessly as `caller` (whose RPC calls run against the real server). */
	async renderModule(moduleId: string, caller: Caller, opts: { width: number; height: number; fullPage: boolean; waitMs: number; actions: RenderAction[]; persist?: boolean }) {
		if (!config.render.enabled) throw new Error("Rendering is disabled (render.enabled = false in outpost.config.json)");
		const html = buildFrame(await this.moduleFiles(moduleId), { moduleId, user: { id: caller.id, name: caller.name, role: caller.role } });
		// By default the render talks to a scratch copy of the server, so clicking through the UI to
		// check it never changes the user's data. persist: true uses the live instance.
		const host = opts.persist ? this.host(moduleId) : this.#scratchHost(moduleId);
		let result;
		try {
			result = await renderModule({ ...opts, html, call: (method, args) => host.call(method, args, caller) });
		} finally {
			if (!opts.persist) await host.dispose();
		}
		// Fit the model's image limits (tall full-page captures get scaled down).
		const processor = await imageProcessor();
		const prepared = processor ? await processor.prepare(new Uint8Array(result.png), "image/png", DEFAULT_IMAGE_LIMITS).catch(() => undefined) : undefined;
		const image = prepared ? { data: prepared.data, mimeType: prepared.mimeType } : { data: result.png.toString("base64"), mimeType: "image/png" };
		const note = prepared?.resized ? `scaled to ${prepared.resized.to.width}x${prepared.resized.to.height} for viewing` : undefined;
		return { ...result, image, note };
	}

	#scratchHost(moduleId: string) {
		const live = this.host(moduleId);
		return new ModuleHost(moduleId, live.env, true);
	}

	async createModule(opts: { name: string; icon?: string; blueprintId?: string; ownerId: string; files?: Record<string, string> }): Promise<ModuleRow> {
		let files = opts.files ?? {};
		let icon = opts.icon;
		if (opts.blueprintId) {
			const bp = blueprints.get(opts.blueprintId);
			if (!bp) throw new HttpError(404, `No blueprint ${opts.blueprintId}`);
			files = { ...bp.files };
			icon ??= bp.icon;
		}
		if (!files["index.html"]) files["index.html"] = STARTER_HTML(opts.name);
		const row = modules.create(this.id, opts.ownerId, opts.name, icon ?? "◆", opts.blueprintId ?? null);
		await this.harness.commit(async (tx) => {
			const src = await tx.doc(ModuleSourceDoc, row.id, null);
			src.files = files;
			src.revision = 1;
		}, ctx);
		this.publishModules();
		return row;
	}

	async moduleFiles(moduleId: string): Promise<Record<string, string>> {
		return { ...((await this.harness.snapshot(ModuleSourceDoc, moduleId, ctx))?.files ?? {}) };
	}

	async moduleLogs(moduleId: string) {
		return [...((await this.harness.snapshot(ModuleLogsDoc, moduleId, ctx))?.lines ?? [])];
	}

	async moduleState(moduleId: string) {
		return { ...((await this.harness.snapshot(ModuleStateDoc, moduleId, ctx))?.kv ?? {}) };
	}

	/** The Airlock grants a module holds (export records which Airlocks it needs). */
	async moduleGrants(moduleId: string) {
		const doc = await this.harness.snapshot(GrantsDoc, ctx);
		return Object.values(doc?.grants ?? {})
			.filter((g) => g.holder.kind === "module" && g.holder.id === moduleId)
			.map((g) => ({ id: g.id, label: g.label, airlock: g.airlock }));
	}

	/** Replace a module's stored data (import). */
	async setModuleState(moduleId: string, kv: Record<string, unknown>) {
		await this.harness.commit(async (tx) => {
			const st = await tx.doc(ModuleStateDoc, moduleId, null);
			st.kv = JSON.parse(JSON.stringify(kv));
		}, ctx);
		this.hosts.get(moduleId)?.reload();
	}

	/** Apply file changes (null deletes) as one revision, then reload the server and every client. */
	async writeModuleFiles(moduleId: string, changes: Record<string, string | null>) {
		for (const path of Object.keys(changes)) {
			if (!/^[\w./-]{1,120}$/.test(path) || path.includes("..")) throw new Error(`Invalid path: ${path}`);
		}
		await this.harness.commit(async (tx) => {
			const src = await tx.doc(ModuleSourceDoc, moduleId, null);
			for (const [path, content] of Object.entries(changes)) {
				if (content === null) delete src.files[path];
				else src.files[path] = content;
			}
			src.revision++;
		}, ctx);
		modules.touch(moduleId);
		this.host(moduleId).reload();
		this.publishModules();
	}

	async deleteModule(moduleId: string) {
		await this.hosts.get(moduleId)?.dispose();
		this.hosts.delete(moduleId);
		await this.harness.commit(async (tx) => {
			await tx.retireDoc(ModuleSourceDoc, moduleId);
			await tx.retireDoc(ModuleStateDoc, moduleId);
			await tx.retireDoc(ModuleLogsDoc, moduleId);
			for (const chat of Object.values((await tx.doc(ChatsDoc)).chats)) if (chat.moduleIds) chat.moduleIds = chat.moduleIds.filter((id) => id !== moduleId);
			const grants = await tx.doc(GrantsDoc);
			for (const [id, g] of Object.entries(grants.grants)) if (g.holder.kind === "module" && g.holder.id === moduleId) delete grants.grants[id];
			const files = await tx.doc(FilesDoc);
			for (const f of Object.values(files.files)) if (f.modules.includes(moduleId)) f.modules = f.modules.filter((g) => g !== moduleId);
		}, ctx).catch(() => {});
		modules.delete(moduleId);
		hub.publish(`module:${moduleId}`, { t: "module.deleted", moduleId });
		this.publishModules();
	}

	async publishBlueprint(moduleId: string, meta: { name: string; description: string; visibility: "public" | "private"; authorId: string }): Promise<BlueprintRow> {
		const g = modules.get(moduleId)!;
		// A module made from a blueprint keeps greeting people the same way once republished.
		const intro = g.blueprintId ? blueprints.get(g.blueprintId)?.intro : undefined;
		const bp: BlueprintRow = { id: newId("bp"), name: meta.name, description: meta.description, icon: g.icon, authorId: meta.authorId, visibility: meta.visibility, files: await this.moduleFiles(moduleId), createdAt: Date.now(), intro };
		blueprints.upsert(bp);
		hub.publish("blueprints", { t: "blueprints.changed" });
		return bp;
	}

	// ------------------------------------------------------------------ airlocks

	/** The Airlock behind a grant: a built-in one, or the workspace connection it points at. */
	async airlockFor(grant: { airlock: string; connection?: string }): Promise<Airlock | undefined> {
		if (!grant.connection) return AIRLOCKS[grant.airlock];
		const conn = await this.connections.get(grant.connection);
		return conn && this.connections.airlock(conn);
	}

	async grant(opts: {
		airlock?: string;
		connection?: string;
		resource?: string;
		label?: string;
		holder: Holder;
		autoApprove?: boolean;
		methods?: string[];
		policy?: Record<string, "ask" | "auto" | "deny">;
		by: string;
		requestId?: string;
	}): Promise<Grant> {
		let gk: Airlock | undefined;
		let resource: string;
		if (opts.connection) {
			const conn = await this.connections.get(opts.connection);
			if (!conn) throw new HttpError(400, `No connection "${opts.connection}"`);
			gk = this.connections.airlock(conn);
			resource = conn.label;
		} else {
			gk = AIRLOCKS[opts.airlock ?? ""];
			if (!gk) throw new HttpError(400, `Unknown airlock ${opts.airlock}`);
			resource = gk.normalizeResource(opts.resource ?? "");
		}
		const methods = opts.methods?.length ? [...new Set(opts.methods)] : undefined;
		const unknown = (methods ?? []).filter((m) => !gk!.methods[m]);
		if (unknown.length && Object.keys(gk.methods).length) throw new HttpError(400, `${gk.title} has no ${unknown.join(", ")}`);
		const policy = checkPolicy(gk, opts.policy, !!opts.autoApprove);
		const grant: Grant = JSON.parse(
			JSON.stringify({
				id: newId("gr"),
				airlock: gk.id,
				resource,
				label: (opts.label?.trim() || (opts.connection ? resource : `${gk.id}:${resource}`)).slice(0, 80),
				holder: opts.holder,
				autoApprove: !!opts.autoApprove && gk.trust !== "byo",
				connection: gk.connection,
				methods,
				policy,
				createdBy: opts.by,
				createdAt: Date.now(),
			}),
		);
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(GrantsDoc);
			doc.grants[grant.id] = grant;
			if (opts.requestId && doc.requests[opts.requestId]) doc.requests[opts.requestId]!.status = "granted";
		}, ctx);
		if (opts.holder.kind === "conversation") await this.#notify(opts.holder.id, `${opts.by} introduced you to ${gk.title} "${resource}" (grant ${grant.id}, label "${grant.label}")${methods ? `, methods: ${methods.join(", ")}` : ""}.`);
		return grant;
	}

	/** Change a grant's approval settings or method subset. */
	async updateGrant(grantId: string, patch: { autoApprove?: boolean; methods?: string[] | null; policy?: Record<string, "ask" | "auto" | "deny"> | null }) {
		const current = (await this.harness.snapshot(GrantsDoc, ctx))?.grants[grantId];
		if (!current) throw new HttpError(404, "No such grant");
		const gk = await this.airlockFor(current);
		if (!gk) throw new HttpError(409, "The Airlock or connection behind this grant is gone");
		const autoApprove = patch.autoApprove ?? current.autoApprove;
		if (autoApprove && gk.trust === "byo") throw new HttpError(400, "Writes on connections added in the UI can't be auto-approved. An admin can declare the connection in outpost.config.json to vet it.");
		const policy = patch.policy === null ? undefined : patch.policy ? checkPolicy(gk, patch.policy, autoApprove) : current.policy;
		await this.harness.commit(async (tx) => {
			const g = (await tx.doc(GrantsDoc)).grants[grantId];
			if (!g) return;
			g.autoApprove = autoApprove;
			if (patch.methods === null || (patch.methods && !patch.methods.length)) delete g.methods;
			else if (patch.methods) g.methods = [...new Set(patch.methods)];
			if (policy) g.policy = JSON.parse(JSON.stringify(policy));
			else delete g.policy;
		}, ctx);
	}

	async revoke(grantId: string) {
		await this.harness.commit(async (tx) => {
			delete (await tx.doc(GrantsDoc)).grants[grantId];
			// Its queued actions can't run any more.
			for (const a of Object.values((await tx.doc(ApprovalsDoc)).actions)) if (a.grantId === grantId && a.status === "pending") Object.assign(a, { status: "rejected", error: "grant was revoked", decidedAt: Date.now(), decidedBy: "outpost" });
		}, ctx);
	}

	/** Remove a connection and everything granted on it. */
	async removeConnection(id: string) {
		const conn = await this.connections.require(id);
		const grants = Object.values((await this.harness.snapshot(GrantsDoc, ctx))?.grants ?? {}).filter((g) => g.connection === conn.id);
		for (const g of grants) await this.revoke(g.id);
		await this.connections.remove(conn.id);
	}

	/** An owner connects a proposal an agent drafted; the agent hears about it and can ask for access. */
	async acceptProposal(id: string, input: Parameters<Connections["accept"]>[1], by: string) {
		const { connection, proposal } = await this.connections.accept(id, input, by);
		const status = connection.status === "ok" ? `It works (${connection.methods.length} methods).` : `It isn't working yet: ${connection.error}`;
		await this.#notify(proposal.proposedBy.id, `${by} added the connection you proposed, "${connection.label}" (${connection.title}). ${status} Ask for access with request_access("${connection.label}") if you need it.`).catch(() => {});
		return connection;
	}

	async declineProposal(id: string, by: string) {
		const proposal = await this.connections.decline(id, by);
		await this.#notify(proposal.proposedBy.id, `${by} declined the connection you proposed ("${proposal.label}").`).catch(() => {});
		return proposal;
	}

	async requestAccess(holder: Holder, airlock: string, resource: string, reason: string, methods?: string[]) {
		const conn = AIRLOCKS[airlock] ? undefined : await this.connections.get(airlock);
		const gk = AIRLOCKS[airlock] ?? (conn && this.connections.airlock(conn));
		if (!gk) {
			const available = [...Object.keys(AIRLOCKS), ...(await this.connections.list()).map((c) => c.label)];
			throw new Error(`Unknown airlock or connection "${airlock}". Available: ${available.join(", ")}`);
		}
		const req: AccessRequest = JSON.parse(
			JSON.stringify({
				id: newId("rq"),
				airlock: gk.id,
				resource: conn ? conn.label : gk.normalizeResource(resource),
				reason,
				holder,
				connection: conn?.id,
				methods: methods?.length ? methods.filter((m) => gk.methods[m]) : undefined,
				status: "pending",
				createdAt: Date.now(),
			}),
		);
		await this.harness.commit(async (tx) => {
			(await tx.doc(GrantsDoc)).requests[req.id] = req;
		}, ctx);
		return req;
	}

	async denyRequest(requestId: string, by: string) {
		let holder: Holder | undefined;
		await this.harness.commit(async (tx) => {
			const r = (await tx.doc(GrantsDoc)).requests[requestId];
			if (r) {
				r.status = "denied";
				holder = r.holder;
			}
		}, ctx);
		if (holder?.kind === "conversation") await this.#notify(holder.id, `${by} denied access request ${requestId}.`);
	}

	async #audit(line: AuditLine) {
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(AuditDoc);
			doc.lines.push(line);
			if (doc.lines.length > 500) doc.lines.splice(0, doc.lines.length - 500);
		}, ctx);
	}

	/** The grant a holder means by `grantRef` (id, label, or a Airlock id it holds exactly one grant of). */
	async grantFor(holder: Holder, grantRef: string): Promise<Grant> {
		const doc = await this.harness.snapshot(GrantsDoc, ctx);
		const held = Object.values(doc?.grants ?? {}).filter((g) => holds(g.holder, holder));
		const byAirlock = held.filter((g) => g.airlock === grantRef);
		const grant = held.find((g) => g.id === grantRef || g.label === grantRef) ?? (byAirlock.length === 1 ? byAirlock[0] : undefined);
		if (!grant) throw new Error(`No grant "${grantRef}" for this ${holder.kind}. Ask the user to introduce the resource (request_access).`);
		return JSON.parse(JSON.stringify(grant));
	}

	/**
	 * The capability check and the deferred-approval engine. Reads run (with pending writes overlaid);
	 * writes run when the grant's policy auto-approves them (never for byo connections or alwaysAsk
	 * methods), are refused when it denies them, and otherwise are simulated and queued for a human.
	 */
	async airlockCall(holder: Holder, grantRef: string, method: string, args: any, requester: Holder & { name: string }) {
		const grant = await this.grantFor(holder, grantRef);
		const gk = await this.airlockFor(grant);
		if (!gk) throw new Error(`The connection behind grant "${grant.label}" was removed.`);
		if (grant.methods && !grant.methods.includes(method)) throw new Error(`Grant "${grant.label}" doesn't include ${method}. It allows: ${grant.methods.join(", ")}. Ask the user (request_access) if you need more.`);
		const m = gk.methods[method];
		if (!m) {
			const names = Object.keys(gk.methods);
			throw new Error(`${gk.title} has no method ${method}. Methods: ${names.slice(0, 60).join(", ")}${names.length > 60 ? ` … (${names.length}; use airlock_tools to search)` : ""}`);
		}
		const missing = ((m.inputSchema?.required as string[] | undefined) ?? []).filter((k) => args?.[k] === undefined || args?.[k] === null || args?.[k] === "");
		if (missing.length) throw new Error(`${method} needs ${missing.join(", ")}. Arguments: ${JSON.stringify(m.inputSchema?.properties ? Object.keys(m.inputSchema.properties as object) : Object.keys(m.params))}`);
		const io = { harness: this.harness };
		const base = { at: Date.now(), grantId: grant.id, airlock: gk.id, method, by: requester.name };
		const runNow = async (detail?: string) => {
			try {
				const result = await m.run(grant.resource, args, io);
				await this.#audit({ ...base, outcome: "ok", ...(detail ? { detail } : {}) });
				return result;
			} catch (error) {
				await this.#audit({ ...base, outcome: "error", detail: String(error).slice(0, 300) });
				throw error;
			}
		};
		if (m.effect === "read") {
			let result = await runNow(gk.connection ? `${grant.label}: read (classified by ${m.classifiedBy ?? "connector"})` : undefined);
			const pending = Object.values((await this.harness.snapshot(ApprovalsDoc, ctx))?.actions ?? {}).filter((a) => a.grantId === grant.id && a.status === "pending");
			if (pending.length && gk.overlay) result = gk.overlay(method, args, result, pending);
			return result;
		}
		const policy = grant.policy?.[method] ?? (grant.autoApprove ? "auto" : "ask");
		if (policy === "deny") {
			await this.#audit({ ...base, outcome: "error", detail: `denied by grant policy: ${m.summarize?.(args) ?? method}` });
			throw new Error(`Grant "${grant.label}" doesn't allow ${method}.`);
		}
		if (policy === "auto" && !m.alwaysAsk && gk.trust !== "byo") return runNow(m.summarize?.(args));
		const id = newId("ap");
		const simulated = m.simulate ? m.simulate(grant.resource, args, id) : { ok: true, simulated: true };
		const action: ApprovalAction = JSON.parse(
			JSON.stringify({
				id,
				grantId: grant.id,
				airlock: gk.id,
				resource: grant.resource,
				method,
				args: args ?? {},
				summary: m.summarize?.(args) ?? `${gk.id}.${method}`,
				status: "pending",
				simulated: simulated ?? null,
				requestedBy: requester,
				createdAt: Date.now(),
			}),
		);
		await this.harness.commit(async (tx) => {
			(await tx.doc(ApprovalsDoc)).actions[id] = action;
		}, ctx);
		await this.#audit({ ...base, outcome: "queued", detail: action.summary });
		return { queuedForApproval: id, note: "Simulated result. The action runs when the user approves it.", result: simulated };
	}

	/** A queued action's state, for whoever asked for it (a chat, a module, a mission agent's conversation). */
	async actionResult(requester: { kind: string; id: string }, actionId: string) {
		const action = (await this.harness.snapshot(ApprovalsDoc, ctx))?.actions[actionId];
		if (!action || action.requestedBy.kind !== requester.kind || action.requestedBy.id !== requester.id) throw new Error(`No action ${actionId} of yours`);
		return { actionId, summary: action.summary, status: action.status, ...(action.result !== undefined ? { result: action.result } : {}), ...(action.error ? { error: action.error } : {}), ...(action.decidedBy ? { decidedBy: action.decidedBy } : {}) };
	}

	async decide(actionId: string, approve: boolean, by: string) {
		const all = (await this.harness.snapshot(ApprovalsDoc, ctx))?.actions ?? {};
		const action = all[actionId];
		if (!action || action.status !== "pending") throw new HttpError(409, "Action is not pending");
		// Arguments may refer to what an earlier queued action will create ("pending:<actionId>").
		let args: any = action.args;
		let blocked: string | undefined;
		if (approve) {
			const r = resolvePending(action.args, all);
			if (r.waitingOn) {
				const dep = all[r.waitingOn]!;
				throw new HttpError(409, `This uses what “${dep.summary}” creates: approve that one first.`);
			}
			args = r.value;
			blocked = r.failedOn;
		}
		const grant = (await this.harness.snapshot(GrantsDoc, ctx))?.grants[action.grantId];
		const gk = grant && (await this.airlockFor(grant));
		let patch: Partial<ApprovalAction>;
		if (!approve) patch = { status: "rejected" };
		else if (!grant) patch = { status: "failed", error: "grant was revoked" };
		else if (!gk?.methods[action.method]) patch = { status: "failed", error: gk ? `${gk.title} no longer has ${action.method}` : "the connection was removed" };
		else if (blocked) patch = { status: "failed", error: `it depends on “${all[blocked]!.summary}”, which was ${all[blocked]!.status}` };
		else {
			try {
				patch = { status: "approved", result: JSON.parse(JSON.stringify((await gk.methods[action.method]!.run(action.resource, args, { harness: this.harness })) ?? null)) };
			} catch (error) {
				patch = { status: "failed", error: error instanceof Error ? error.message : String(error) };
			}
		}
		await this.harness.commit(async (tx) => {
			const a = (await tx.doc(ApprovalsDoc)).actions[actionId];
			if (a) Object.assign(a, patch, { decidedAt: Date.now(), decidedBy: by });
		}, ctx);
		await this.#audit({ at: Date.now(), grantId: action.grantId, airlock: action.airlock, method: action.method, by, outcome: patch.status === "approved" ? "ok" : "error", detail: `${patch.status}: ${action.summary}` });
		if (action.requestedBy.kind === "conversation") {
			const outcome = patch.status === "approved" ? `was approved and executed${patch.result !== null && patch.result !== undefined ? `; result: ${JSON.stringify(patch.result).slice(0, 1500)}` : ""}` : patch.status === "rejected" ? `was rejected by ${by}` : `failed: ${patch.error}`;
			await this.#notify(action.requestedBy.id, `Queued action ${actionId} (${action.summary}) ${outcome}.`, true);
		}
		return patch;
	}

	/** Tell a chat's agent something happened, without starting a run. Visible in the transcript too. */
	async #notify(chatId: string, message: string, quiet = false) {
		const c = await this.harness.conversation(Number(chatId) as any, ctx);
		await c?.submit(
			{
				type: "write",
				entry: { kind: "outpost.notice", data: { text: message, quiet }, model: [{ role: "user", content: `[outpost notice] ${message}`, timestamp: Date.now() }] },
			},
			ctx,
		);
	}

	/** Module access for a signed-in user, or a 404/403. */
	static async moduleFor(moduleId: string, user: User, minRole: "viewer" | "editor" | "owner" = "viewer") {
		const g = modules.get(moduleId);
		if (!g) throw new HttpError(404, "No such module");
		const role = modules.role(g, user.id);
		const rank = { viewer: 1, editor: 2, owner: 3 };
		if (!role) throw new HttpError(404, "No such module");
		if (rank[role] < rank[minRole]) throw new HttpError(403, `Requires ${minRole} access`);
		const ws = await Workspace.get(g.workspaceId);
		const caller: Caller = { kind: "user", id: user.id, name: user.displayName, role };
		return { module: g, role, ws, caller };
	}
}

const STARTER_HTML = (name: string) => `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #faf8f3; color: #222; }
  .card { text-align: center; padding: 2rem; }
  h1 { font-weight: 650; letter-spacing: -0.02em; margin: 0 0 .25rem; }
  p { color: #777; margin: 0; }
</style></head>
<body><div class="card"><h1>${name.replace(/[<>&]/g, "")}</h1><p>An empty module. Ask the agent to build it.</p></div></body>
</html>`;

/**
 * A grant's per-method policy, checked: only write methods, "auto" only where it can apply (never for
 * byo connections or alwaysAsk methods).
 */
function checkPolicy(gk: Airlock, policy: Record<string, string> | undefined, autoApprove: boolean): Record<string, "ask" | "auto" | "deny"> | undefined {
	if (autoApprove && gk.trust === "byo") throw new HttpError(400, "Writes on connections added in the UI can't be auto-approved. An admin can declare the connection in outpost.config.json to vet it.");
	if (!policy || !Object.keys(policy).length) return undefined;
	const out: Record<string, "ask" | "auto" | "deny"> = {};
	for (const [name, value] of Object.entries(policy)) {
		const m = gk.methods[name];
		if (!m) throw new HttpError(400, `${gk.title} has no ${name}`);
		if (m.effect !== "write") continue;
		if (value !== "ask" && value !== "auto" && value !== "deny") throw new HttpError(400, `Policy for ${name} must be ask, auto or deny`);
		if (value === "auto" && gk.trust === "byo") throw new HttpError(400, `Writes on connections added in the UI can't be auto-approved (${name})`);
		if (value === "auto" && m.alwaysAsk) throw new HttpError(400, `${name} always asks: it can't be auto-approved`);
		out[name] = value;
	}
	return Object.keys(out).length ? out : undefined;
}

/**
 * Replace "pending:<actionId>" values (ids a simulated result handed out) with the real id from that
 * action's result once it ran. waitingOn: it hasn't been approved yet; failedOn: it was rejected or failed.
 */
export function resolvePending(value: unknown, actions: Record<string, ApprovalAction>): { value: unknown; waitingOn?: string; failedOn?: string } {
	let waitingOn: string | undefined;
	let failedOn: string | undefined;
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			const m = /^pending:(ap_[A-Za-z0-9]+)$/.exec(v.trim());
			const dep = m && actions[m[1]!];
			if (!dep) return v;
			if (dep.status === "pending") waitingOn ??= dep.id;
			else if (dep.status !== "approved") failedOn ??= dep.id;
			else {
				const r: any = dep.result;
				const real = r?.id ?? r?.pullRequestId ?? r?.number ?? r?.thread;
				if (real !== undefined && !String(real).startsWith("pending:")) return real;
			}
			return v;
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	const out = walk(value);
	return { value: out, waitingOn, failedOn };
}
