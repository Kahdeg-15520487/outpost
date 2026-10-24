import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, watchEvents, type Conversation, type Extension } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { config } from "../config.ts";
import { hub } from "../collab/hub.ts";
import { createOsExtension } from "../agent/extension.ts";
import { GadgetHost, type Caller } from "../gadgets/host.ts";
import { GATEKEEPERS } from "../gatekeepers/catalog.ts";
import { FileStore, formatBytes, imageProcessor, looksLikeText } from "../files/store.ts";
import { buildFrame } from "../gadgets/frame.ts";
import { renderGadget, type RenderAction } from "../gadgets/render.ts";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import {
	ApprovalsDoc,
	AuditDoc,
	ChatsDoc,
	FilesDoc,
	GadgetLogsDoc,
	GadgetSourceDoc,
	GadgetStateDoc,
	GrantsDoc,
	MailboxDoc,
	type ApprovalAction,
	type AuditLine,
	type FileMeta,
	type Grant,
	type Holder,
} from "./docs.ts";
import { defaultModel, models } from "./models.ts";
import { watchRuns, watchRunning } from "./home.ts";
import { ProjectManager } from "../projects/manager.ts";
import { agentEnv } from "../projects/env.ts";
import { blueprints, gadgets, HttpError, newId, users, workspaces, type BlueprintRow, type GadgetRow, type User, type WorkspaceRow } from "./system-db.ts";

const open = new Map<string, Promise<Workspace>>();
const codemodeSandbox = new CodemodeSandbox({ memoryLimitBytes: 128 * 1024 * 1024 });

/**
 * One workspace = one pi-durable Harness over its own SQLite file. Chats are conversations, gadget
 * code/state/logs and Gatekeeper grants/approvals are documents in it. Everything is committed
 * before it is shown, and unfinished agent runs continue after a restart (`harness.resume()`).
 */
export class Workspace {
	readonly hosts = new Map<string, GadgetHost>();
	readonly channel: string;
	readonly files: FileStore;
	/** Agent teams (projects) in this workspace. */
	projects!: ProjectManager;
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
		ws?.projects?.stop();
		await ws?.harness.close(ctx).catch(() => {});
	}

	static async closeAll() {
		for (const p of open.values()) {
			const ws = await p.catch(() => undefined);
			ws?.projects?.stop();
			await ws?.harness.close(ctx).catch(() => {});
		}
	}

	static async #open(id: string): Promise<Workspace> {
		const registry = createRegistry();
		const storage = await openNodeSqliteStorage(join(config.workspaceDir, `${id}.sqlite`));
		let self: Workspace | undefined;
		// Chats keep exactly the OS + code mode extensions; project agents select coding tools + project tools.
		let chatExtensions: Extension[] | undefined;
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				identity: { attribution: { name: "pi-os", url: "https://pi.dev" } },
				// Project agents' file/bash tools run in their own worktree (their agent `cwd`).
				// (Git Bash paths translated; file writes confined to the worktree — see projects/env.ts.)
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
		const osExtension = createOsExtension(ws);
		const codemode = createCodemodeExtension({ sandbox: codemodeSandbox, models: false });
		registry.install(osExtension);
		registry.install(codemode);
		chatExtensions = [osExtension, codemode];
		ws.projects = new ProjectManager(ws);
		registry.install(ws.projects.coding);
		registry.install(ws.projects.extension);
		await ws.#watchDocs();
		await ws.projects.init();
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

	publishGadgets() {
		hub.publish(this.channel, { t: "ws.gadgets", ws: this.id });
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
					chats.chats[String(id)] = { id: String(id), title: title?.trim() || "New chat", createdAt: Date.now(), createdBy: user.displayName, updatedAt: Date.now() };
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
		const keep = agent.tools.filter((t) => ["codemode", "gadget_write", "gadget_edit", "subagent"].includes(t.name));
		if (codemode) await conversation.configure({ modelTools: keep }, ctx);
	}

	async conversation(id: string): Promise<Conversation> {
		const c = await this.harness.conversation(Number(id) as any, ctx);
		if (!c) throw new HttpError(404, "No such chat");
		return c;
	}

	async send(chatId: string, user: User, content: string, mode: "followUp" | "steer" = "followUp", fileIds: string[] = [], gadgetId?: string) {
		const c = await this.conversation(chatId);
		// Follow the run from the start — and before submitting, so a fast run can't end unrecorded. It may
		// well finish while nobody has the chat open; that is exactly what the homepage reports on.
		await watchRuns(this, chatId).catch(() => {});
		const attached: FileMeta[] = [];
		for (const id of fileIds) attached.push(await this.files.get(id));
		for (const f of attached) if (!f.chatId) await this.files.update(f.id, (m) => void (m.chatId = chatId));
		if (!content.trim() && attached.length) content = attached.length === 1 ? `(attached ${attached[0]!.name})` : `(attached ${attached.length} files)`;
		// The user typed this with a gadget open beside the chat: "this deck", "the board", "it" mean that gadget.
		const open = gadgetId ? gadgets.get(gadgetId) : undefined;
		const focus = open?.workspaceId === this.id ? `[pi-os: the user has gadget ${open.id} "${open.name}"${open.blueprintId ? ` (from blueprint ${open.blueprintId})` : ""} open next to this chat. Unless they say otherwise, "this", "it" and the like refer to that gadget — use the gadget tools on it, and read its API first.]\n\n` : "";
		await this.harness.commit(async (tx) => {
			const chats = await tx.doc(ChatsDoc);
			const chat = chats.chats[chatId];
			if (chat) {
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
					kind: "os.user",
					data: { author: user.displayName, authorId: user.id, text: content, files: attached.map((f) => ({ id: f.id, name: f.name, kind: f.kind, mime: f.mime, size: f.size })) },
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

	// ------------------------------------------------------------------ gadgets

	host(gadgetId: string): GadgetHost {
		let host = this.hosts.get(gadgetId);
		if (!host) {
			host = new GadgetHost(gadgetId, {
				harness: this.harness,
				files: this.files,
				name: () => gadgets.get(gadgetId)?.name ?? gadgetId,
				gatekeeper: (gid, grant, method, args, caller) =>
					this.gatekeeperCall({ kind: "gadget", id: gid }, grant, method, args, { kind: "gadget", id: gid, name: `${gadgets.get(gid)?.name ?? gid} (${caller.name})` }),
			});
			this.hosts.set(gadgetId, host);
		}
		return host;
	}

	/** Render a gadget's client headlessly as `caller` (whose RPC calls run against the real server). */
	async renderGadget(gadgetId: string, caller: Caller, opts: { width: number; height: number; fullPage: boolean; waitMs: number; actions: RenderAction[]; persist?: boolean }) {
		if (!config.render.enabled) throw new Error("Rendering is disabled (render.enabled = false in pi-os.config.json)");
		const html = buildFrame(await this.gadgetFiles(gadgetId), { gadgetId, user: { id: caller.id, name: caller.name, role: caller.role } });
		// By default the render talks to a scratch copy of the server, so clicking through the UI to
		// check it never changes the user's data. persist: true uses the live instance.
		const host = opts.persist ? this.host(gadgetId) : this.#scratchHost(gadgetId);
		let result;
		try {
			result = await renderGadget({ ...opts, html, call: (method, args) => host.call(method, args, caller) });
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

	#scratchHost(gadgetId: string) {
		const live = this.host(gadgetId);
		return new GadgetHost(gadgetId, live.env, true);
	}

	async createGadget(opts: { name: string; icon?: string; blueprintId?: string; ownerId: string; files?: Record<string, string> }): Promise<GadgetRow> {
		let files = opts.files ?? {};
		let icon = opts.icon;
		if (opts.blueprintId) {
			const bp = blueprints.get(opts.blueprintId);
			if (!bp) throw new HttpError(404, `No blueprint ${opts.blueprintId}`);
			files = { ...bp.files };
			icon ??= bp.icon;
		}
		if (!files["index.html"]) files["index.html"] = STARTER_HTML(opts.name);
		const row = gadgets.create(this.id, opts.ownerId, opts.name, icon ?? "◆", opts.blueprintId ?? null);
		await this.harness.commit(async (tx) => {
			const src = await tx.doc(GadgetSourceDoc, row.id, null);
			src.files = files;
			src.revision = 1;
		}, ctx);
		this.publishGadgets();
		return row;
	}

	async gadgetFiles(gadgetId: string): Promise<Record<string, string>> {
		return { ...((await this.harness.snapshot(GadgetSourceDoc, gadgetId, ctx))?.files ?? {}) };
	}

	async gadgetLogs(gadgetId: string) {
		return [...((await this.harness.snapshot(GadgetLogsDoc, gadgetId, ctx))?.lines ?? [])];
	}

	async gadgetState(gadgetId: string) {
		return { ...((await this.harness.snapshot(GadgetStateDoc, gadgetId, ctx))?.kv ?? {}) };
	}

	/** The Gatekeeper grants a gadget holds (export records which Gatekeepers it needs). */
	async gadgetGrants(gadgetId: string) {
		const doc = await this.harness.snapshot(GrantsDoc, ctx);
		return Object.values(doc?.grants ?? {})
			.filter((g) => g.holder.kind === "gadget" && g.holder.id === gadgetId)
			.map((g) => ({ id: g.id, label: g.label, gatekeeper: g.gatekeeper }));
	}

	/** Replace a gadget's stored data (import). */
	async setGadgetState(gadgetId: string, kv: Record<string, unknown>) {
		await this.harness.commit(async (tx) => {
			const st = await tx.doc(GadgetStateDoc, gadgetId, null);
			st.kv = JSON.parse(JSON.stringify(kv));
		}, ctx);
		this.hosts.get(gadgetId)?.reload();
	}

	/** Apply file changes (null deletes) as one revision, then reload the server and every client. */
	async writeGadgetFiles(gadgetId: string, changes: Record<string, string | null>) {
		for (const path of Object.keys(changes)) {
			if (!/^[\w./-]{1,120}$/.test(path) || path.includes("..")) throw new Error(`Invalid path: ${path}`);
		}
		await this.harness.commit(async (tx) => {
			const src = await tx.doc(GadgetSourceDoc, gadgetId, null);
			for (const [path, content] of Object.entries(changes)) {
				if (content === null) delete src.files[path];
				else src.files[path] = content;
			}
			src.revision++;
		}, ctx);
		gadgets.touch(gadgetId);
		this.host(gadgetId).reload();
		this.publishGadgets();
	}

	async deleteGadget(gadgetId: string) {
		await this.hosts.get(gadgetId)?.dispose();
		this.hosts.delete(gadgetId);
		await this.harness.commit(async (tx) => {
			await tx.retireDoc(GadgetSourceDoc, gadgetId);
			await tx.retireDoc(GadgetStateDoc, gadgetId);
			await tx.retireDoc(GadgetLogsDoc, gadgetId);
			const grants = await tx.doc(GrantsDoc);
			for (const [id, g] of Object.entries(grants.grants)) if (g.holder.kind === "gadget" && g.holder.id === gadgetId) delete grants.grants[id];
			const files = await tx.doc(FilesDoc);
			for (const f of Object.values(files.files)) if (f.gadgets.includes(gadgetId)) f.gadgets = f.gadgets.filter((g) => g !== gadgetId);
		}, ctx).catch(() => {});
		gadgets.delete(gadgetId);
		hub.publish(`gadget:${gadgetId}`, { t: "gadget.deleted", gadgetId });
		this.publishGadgets();
	}

	async publishBlueprint(gadgetId: string, meta: { name: string; description: string; visibility: "public" | "private"; authorId: string }): Promise<BlueprintRow> {
		const g = gadgets.get(gadgetId)!;
		// A gadget made from a blueprint keeps greeting people the same way once republished.
		const intro = g.blueprintId ? blueprints.get(g.blueprintId)?.intro : undefined;
		const bp: BlueprintRow = { id: newId("bp"), name: meta.name, description: meta.description, icon: g.icon, authorId: meta.authorId, visibility: meta.visibility, files: await this.gadgetFiles(gadgetId), createdAt: Date.now(), intro };
		blueprints.upsert(bp);
		hub.publish("blueprints", { t: "blueprints.changed" });
		return bp;
	}

	// ------------------------------------------------------------------ gatekeepers

	async grant(opts: { gatekeeper: string; resource: string; label?: string; holder: Holder; autoApprove?: boolean; by: string; requestId?: string }): Promise<Grant> {
		const gk = GATEKEEPERS[opts.gatekeeper];
		if (!gk) throw new HttpError(400, `Unknown gatekeeper ${opts.gatekeeper}`);
		const resource = gk.normalizeResource(opts.resource);
		const grant: Grant = {
			id: newId("gr"),
			gatekeeper: gk.id,
			resource,
			label: (opts.label?.trim() || `${gk.id}:${resource}`).slice(0, 80),
			holder: opts.holder,
			autoApprove: !!opts.autoApprove,
			createdBy: opts.by,
			createdAt: Date.now(),
		};
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(GrantsDoc);
			doc.grants[grant.id] = grant;
			if (opts.requestId && doc.requests[opts.requestId]) doc.requests[opts.requestId]!.status = "granted";
		}, ctx);
		if (opts.holder.kind === "conversation") await this.#notify(opts.holder.id, `${opts.by} introduced you to ${gk.title} "${resource}" (grant ${grant.id}, label "${grant.label}").`);
		return grant;
	}

	async revoke(grantId: string) {
		await this.harness.commit(async (tx) => {
			delete (await tx.doc(GrantsDoc)).grants[grantId];
		}, ctx);
	}

	async requestAccess(holder: Holder, gatekeeper: string, resource: string, reason: string) {
		const gk = GATEKEEPERS[gatekeeper];
		if (!gk) throw new Error(`Unknown gatekeeper "${gatekeeper}". Available: ${Object.keys(GATEKEEPERS).join(", ")}`);
		const req = { id: newId("rq"), gatekeeper, resource: gk.normalizeResource(resource), reason, holder, status: "pending" as const, createdAt: Date.now() };
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

	/**
	 * The capability check and the deferred-approval engine. Reads run (with pending writes overlaid);
	 * writes either run (auto-approve grants) or are simulated and queued for a human.
	 */
	async gatekeeperCall(holder: Holder, grantRef: string, method: string, args: any, requester: Holder & { name: string }) {
		const doc = await this.harness.snapshot(GrantsDoc, ctx);
		const held = Object.values(doc?.grants ?? {}).filter((g) => g.holder.kind === holder.kind && g.holder.id === holder.id);
		const byGatekeeper = held.filter((g) => g.gatekeeper === grantRef);
		const grant = held.find((g) => g.id === grantRef || g.label === grantRef) ?? (byGatekeeper.length === 1 ? byGatekeeper[0] : undefined);
		if (!grant) throw new Error(`No grant "${grantRef}" for this ${holder.kind}. Ask the user to introduce the resource (request_access).`);
		const gk = GATEKEEPERS[grant.gatekeeper]!;
		const m = gk.methods[method];
		if (!m) throw new Error(`${gk.id} has no method ${method}. Methods: ${Object.keys(gk.methods).join(", ")}`);
		const io = { harness: this.harness };
		const base = { at: Date.now(), grantId: grant.id, gatekeeper: gk.id, method, by: requester.name };
		if (m.effect === "read") {
			try {
				let result = await m.run(grant.resource, args, io);
				const pending = Object.values((await this.harness.snapshot(ApprovalsDoc, ctx))?.actions ?? {}).filter((a) => a.grantId === grant.id && a.status === "pending");
				if (pending.length && gk.overlay) result = gk.overlay(method, args, result, pending);
				await this.#audit({ ...base, outcome: "ok" });
				return result;
			} catch (error) {
				await this.#audit({ ...base, outcome: "error", detail: String(error).slice(0, 300) });
				throw error;
			}
		}
		if (grant.autoApprove) {
			try {
				const result = await m.run(grant.resource, args, io);
				await this.#audit({ ...base, outcome: "ok", detail: m.summarize?.(args) });
				return result;
			} catch (error) {
				await this.#audit({ ...base, outcome: "error", detail: String(error).slice(0, 300) });
				throw error;
			}
		}
		const id = newId("ap");
		const simulated = m.simulate ? m.simulate(grant.resource, args, id) : { ok: true, simulated: true };
		const action: ApprovalAction = {
			id,
			grantId: grant.id,
			gatekeeper: gk.id,
			resource: grant.resource,
			method,
			args,
			summary: m.summarize?.(args) ?? `${gk.id}.${method}`,
			status: "pending",
			simulated,
			requestedBy: requester,
			createdAt: Date.now(),
		};
		await this.harness.commit(async (tx) => {
			(await tx.doc(ApprovalsDoc)).actions[id] = action;
		}, ctx);
		await this.#audit({ ...base, outcome: "queued", detail: action.summary });
		return { queuedForApproval: id, note: "Simulated result. The action runs when the user approves it.", result: simulated };
	}

	async decide(actionId: string, approve: boolean, by: string) {
		const action = (await this.harness.snapshot(ApprovalsDoc, ctx))?.actions[actionId];
		if (!action || action.status !== "pending") throw new HttpError(409, "Action is not pending");
		const grant = (await this.harness.snapshot(GrantsDoc, ctx))?.grants[action.grantId];
		let patch: Partial<ApprovalAction>;
		if (!approve) patch = { status: "rejected" };
		else if (!grant) patch = { status: "failed", error: "grant was revoked" };
		else {
			try {
				patch = { status: "approved", result: (await GATEKEEPERS[action.gatekeeper]!.methods[action.method]!.run(action.resource, action.args, { harness: this.harness })) ?? null };
			} catch (error) {
				patch = { status: "failed", error: error instanceof Error ? error.message : String(error) };
			}
		}
		await this.harness.commit(async (tx) => {
			const a = (await tx.doc(ApprovalsDoc)).actions[actionId];
			if (a) Object.assign(a, patch, { decidedAt: Date.now(), decidedBy: by });
		}, ctx);
		await this.#audit({ at: Date.now(), grantId: action.grantId, gatekeeper: action.gatekeeper, method: action.method, by, outcome: patch.status === "approved" ? "ok" : "error", detail: `${patch.status}: ${action.summary}` });
		if (action.requestedBy.kind === "conversation") {
			const outcome = patch.status === "approved" ? `was approved and executed` : patch.status === "rejected" ? `was rejected by ${by}` : `failed: ${patch.error}`;
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
				entry: { kind: "os.notice", data: { text: message, quiet }, model: [{ role: "user", content: `[pi-os notice] ${message}`, timestamp: Date.now() }] },
			},
			ctx,
		);
	}

	/** Gadget access for a signed-in user, or a 404/403. */
	static async gadgetFor(gadgetId: string, user: User, minRole: "viewer" | "editor" | "owner" = "viewer") {
		const g = gadgets.get(gadgetId);
		if (!g) throw new HttpError(404, "No such gadget");
		const role = gadgets.role(g, user.id);
		const rank = { viewer: 1, editor: 2, owner: 3 };
		if (!role) throw new HttpError(404, "No such gadget");
		if (rank[role] < rank[minRole]) throw new HttpError(403, `Requires ${minRole} access`);
		const ws = await Workspace.get(g.workspaceId);
		const caller: Caller = { kind: "user", id: user.id, name: user.displayName, role };
		return { gadget: g, role, ws, caller };
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
<body><div class="card"><h1>${name.replace(/[<>&]/g, "")}</h1><p>An empty gadget. Ask the agent to build it.</p></div></body>
</html>`;
