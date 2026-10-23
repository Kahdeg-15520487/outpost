import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { config } from "../config.ts";
import { describeGatekeeper, GATEKEEPERS } from "../gatekeepers/catalog.ts";
import { buildFrame, FRAME_CSP } from "../gadgets/frame.ts";
import { bundleFileName, importBundle, makeBundle, parseBundle } from "../gadgets/bundle.ts";
import { credentials, defaultModel, listModels, listProviders, models } from "../kernel/models.ts";
import { oauthLogins } from "../kernel/oauth.ts";
import { blueprints, gadgets, HttpError, sessions, sign, users, verify, workspaces, ROLE_RANK, type Role, type User } from "../kernel/system-db.ts";
import { Workspace } from "../kernel/workspace.ts";
import { hub } from "../collab/hub.ts";
import { readRaw, Router, type Req } from "./util.ts";

const cookie = (token: string, maxAge: number) => `pios_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const asRole = (r: unknown): Role => {
	if (r === "viewer" || r === "editor" || r === "owner") return r;
	throw new HttpError(400, "role must be viewer|editor|owner");
};

async function member(req: Req, min: Role = "viewer") {
	const user = req.need();
	const role = workspaces.role(req.params.ws!, user.id);
	if (!role) throw new HttpError(404, "No such workspace");
	if (ROLE_RANK[role] < ROLE_RANK[min]) throw new HttpError(403, `Requires ${min}`);
	return { user, role, ws: await Workspace.get(req.params.ws!) };
}

function gadgetView(g: ReturnType<typeof gadgets.get> & {}, role: Role) {
	const ws = workspaces.get(g.workspaceId);
	const bp = g.blueprintId ? blueprints.get(g.blueprintId) : undefined;
	const blueprint = bp && { name: bp.name, description: bp.description, ...bp.intro };
	return { ...g, role, workspaceName: ws?.name, owner: users.get(g.ownerId)?.displayName, blueprint };
}

function signIn(req: Req, user: User) {
	req.res.setHeader("set-cookie", cookie(sessions.create(user.id), 30 * 86400));
	return { user };
}

export function createApi(): Router {
	const r = new Router();

	// ------------------------------------------------------------ auth
	r.post("/api/auth/signup", async (req) => {
		const { username, password, displayName } = await req.body();
		const user = users.create(String(username ?? ""), String(password ?? ""), displayName);
		workspaces.create(`${user.displayName}'s workspace`, user.id);
		return signIn(req, user);
	});
	r.post("/api/auth/login", async (req) => {
		const { username, password } = await req.body();
		return signIn(req, users.login(String(username ?? ""), String(password ?? "")));
	});
	r.post("/api/auth/logout", (req) => {
		const token = /pios_session=([^;]+)/.exec(req.raw.headers.cookie ?? "")?.[1];
		if (token) sessions.delete(token);
		req.res.setHeader("set-cookie", cookie("", 0));
		return { ok: true };
	});
	r.get("/api/me", (req) => ({ user: req.user ?? null, firstRun: users.count() === 0 }));

	// ------------------------------------------------------------ models & providers
	r.get("/api/models", async (req) => {
		const user = req.need();
		const ws = req.query.get("ws");
		const settings = ws && workspaces.role(ws, user.id) ? workspaces.get(ws)?.settings : undefined;
		// What a new chat would get, so the picker can show it before the chat exists.
		const picker = users.prefs(user.id).modelPicker ?? {};
		return { models: await listModels(), default: await defaultModel(settings?.defaultModel, picker), picker };
	});
	/** Which models this user's picker shows: { provider: [modelId…] }; omitted providers show everything. */
	r.put("/api/me/model-picker", async (req) => {
		const user = req.need();
		const { picker } = await req.body();
		if (picker !== null && (typeof picker !== "object" || Array.isArray(picker))) throw new HttpError(400, "picker must be an object or null");
		const clean: Record<string, string[]> = {};
		for (const [provider, ids] of Object.entries(picker ?? {}).slice(0, 200)) {
			if (!Array.isArray(ids)) throw new HttpError(400, `picker.${provider} must be an array of model ids`);
			clean[String(provider).slice(0, 100)] = [...new Set(ids.map(String))].slice(0, 2000);
		}
		return { picker: users.setPrefs(user.id, { modelPicker: Object.keys(clean).length ? clean : undefined }).modelPicker ?? {} };
	});
	r.get("/api/providers", async (req) => {
		req.need();
		const providers = await Promise.all((await listProviders()).map(async (p) => ({ ...p, oauth: await oauthLogins.describe(p.id) })));
		return { providers, configPath: config.configPath, configFound: config.configFound, ambientEnv: config.ambientEnv };
	});
	// OAuth sign-in (device-code flows, e.g. GitHub Copilot). The flow runs here; Settings polls it.
	r.post("/api/providers/:id/oauth", async (req) => ({ login: oauthLogins.start(req.params.id!, req.need().displayName) }));
	r.get("/api/providers/:id/oauth", async (req) => (req.need(), { login: oauthLogins.get(req.params.id!) ?? null }));
	r.post("/api/providers/:id/oauth/answer", async (req) => {
		req.need();
		const { promptId, value } = await req.body();
		return { login: oauthLogins.answer(req.params.id!, Number(promptId), String(value ?? "")) };
	});
	r.post("/api/providers/:id/oauth/cancel", async (req) => (req.need(), { login: oauthLogins.cancel(req.params.id!) ?? null }));
	r.delete("/api/providers/:id/oauth", async (req) => {
		req.need();
		await oauthLogins.signOut(req.params.id!);
		return { ok: true };
	});
	r.post("/api/providers/:id/key", async (req) => {
		req.need();
		const { key } = await req.body();
		if (!models.getProvider(req.params.id!)) throw new HttpError(404, "Unknown provider");
		if (credentials.managedByConfig(req.params.id!)) throw new HttpError(409, `The ${req.params.id} key is set in pi-os.config.json; change it there.`);
		if (key) await credentials.modify(req.params.id!, async (current) => ({ ...(current?.type === "api_key" ? current : {}), type: "api_key", key: String(key) }));
		else await credentials.delete(req.params.id!);
		return { ok: true };
	});

	// ------------------------------------------------------------ workspaces
	r.get("/api/workspaces", (req) => ({ workspaces: workspaces.forUser(req.need().id) }));
	r.post("/api/workspaces", async (req) => {
		const { name } = await req.body();
		return { workspace: workspaces.create(String(name || "Untitled workspace").slice(0, 80), req.need().id) };
	});
	r.get("/api/w/:ws", async (req) => {
		const { role } = await member(req);
		return { workspace: { ...workspaces.get(req.params.ws!), role }, members: workspaces.members(req.params.ws!) };
	});
	r.patch("/api/w/:ws", async (req) => {
		await member(req, "owner");
		const { name, settings } = await req.body();
		workspaces.update(req.params.ws!, { name, settings });
		return { workspace: workspaces.get(req.params.ws!) };
	});
	r.post("/api/w/:ws/members", async (req) => {
		await member(req, "owner");
		const { username, role } = await req.body();
		const target = users.byUsername(String(username));
		if (!target) throw new HttpError(404, `No user "${username}"`);
		workspaces.setMember(req.params.ws!, target.id, role === null ? null : asRole(role));
		return { members: workspaces.members(req.params.ws!) };
	});

	// ------------------------------------------------------------ chats
	r.post("/api/w/:ws/chats", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { title, model } = await req.body();
		return { id: await ws.createChat(user, title, model) };
	});
	r.patch("/api/w/:ws/chats/:chat", async (req) => {
		const { ws } = await member(req, "editor");
		const { title, model, thinkingLevel } = await req.body();
		if (title) await ws.renameChat(req.params.chat!, String(title));
		if (model || thinkingLevel) {
			const c = await ws.conversation(req.params.chat!);
			await c.configure({ ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) }, ctx);
		}
		return { ok: true };
	});
	r.delete("/api/w/:ws/chats/:chat", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.archiveChat(req.params.chat!);
		return { ok: true };
	});
	r.post("/api/w/:ws/chats/:chat/messages", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { content, mode, files, gadget } = await req.body();
		const fileIds = Array.isArray(files) ? files.map(String).slice(0, 20) : [];
		if (!String(content ?? "").trim() && !fileIds.length) throw new HttpError(400, "Empty message");
		return { submission: await ws.send(req.params.chat!, user, String(content ?? ""), mode === "steer" ? "steer" : "followUp", fileIds, typeof gadget === "string" ? gadget : undefined) };
	});
	r.post("/api/w/:ws/chats/:chat/abort", async (req) => {
		const { ws } = await member(req, "editor");
		await (await ws.conversation(req.params.chat!)).abort(ctx);
		return { ok: true };
	});
	r.post("/api/w/:ws/chats/:chat/compact", async (req) => {
		const { ws } = await member(req, "editor");
		await (await ws.conversation(req.params.chat!)).compact(undefined, ctx);
		return { ok: true };
	});
	r.get("/api/w/:ws/tasks", async (req) => {
		const { ws } = await member(req);
		const inspection = await ws.harness.inspect(ctx);
		return {
			scheduling: inspection.scheduling,
			tasks: inspection.tasks.map((t) => ({ id: t.record.id, kind: t.record.kind, conversationId: t.record.conversationId, state: t.state.kind, reason: (t.state as any).reason })),
		};
	});
	r.post("/api/w/:ws/tasks/:task/retry", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.harness.retryTask(Number(req.params.task) as any, ctx);
		return { ok: true };
	});
	r.get("/api/w/:ws/usage", async (req) => {
		const { ws } = await member(req);
		return await ws.harness.usage(ctx);
	});

	// ------------------------------------------------------------ files
	// Upload: raw body; name in `x-file-name` (URI-encoded), type in content-type.
	r.post("/api/w/:ws/files", async (req) => {
		const { user, ws } = await member(req, "editor");
		const name = decodeURIComponent(String(req.raw.headers["x-file-name"] ?? "upload"));
		const bytes = await readRaw(req, config.maxUploadBytes);
		const meta = await ws.files.put(bytes, { name, mime: req.raw.headers["content-type"], createdBy: user.displayName, source: "upload", chatId: req.query.get("chat") ?? undefined });
		return { file: meta };
	});
	r.get("/api/w/:ws/files", async (req) => {
		const { ws } = await member(req);
		return { files: await ws.files.list() };
	});
	r.get("/api/w/:ws/files/:id", async (req) => {
		const { ws } = await member(req);
		const meta = await ws.files.get(req.params.id!).catch(() => {
			throw new HttpError(404, "No such file");
		});
		// Uploaded files are untrusted: never render them as active content on our origin.
		const inlineSafe = req.query.has("inline") && /^image\/(png|jpeg|gif|webp|bmp)$|^text\/plain$|^application\/pdf$/.test(meta.mime);
		req.res.writeHead(200, {
			"content-type": inlineSafe ? meta.mime : "application/octet-stream",
			"content-length": meta.size,
			"content-disposition": `${inlineSafe ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
			"content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
			"x-content-type-options": "nosniff",
			"cache-control": "private, max-age=3600",
		});
		req.res.end(ws.files.all(meta));
	});
	r.patch("/api/w/:ws/files/:id", async (req) => {
		const { ws } = await member(req, "editor");
		const { name, gadgets: allow } = await req.body();
		await ws.files.get(req.params.id!);
		await ws.files.update(req.params.id!, (m) => {
			if (typeof name === "string" && name.trim()) m.name = name.trim().slice(0, 240);
			if (Array.isArray(allow)) m.gadgets = allow.map(String).filter((g) => gadgets.get(g)?.workspaceId === ws.id);
		});
		return { ok: true };
	});
	r.delete("/api/w/:ws/files/:id", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.files.delete(req.params.id!);
		return { ok: true };
	});

	// ------------------------------------------------------------ projects (agent teams)
	r.get("/api/w/:ws/projects", async (req) => {
		const { ws } = await member(req);
		return { projects: await ws.projects.list() };
	});
	r.post("/api/w/:ws/projects", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { goal, name, model, files } = await req.body();
		const chosen = model?.provider && model?.modelId ? { provider: String(model.provider), modelId: String(model.modelId) } : await defaultModel(ws.row.settings.defaultModel, users.prefs(user.id).modelPicker);
		return { project: await ws.projects.create(user, { goal: String(goal ?? ""), name: name ? String(name).slice(0, 80) : undefined, model: chosen, files: Array.isArray(files) ? files.map(String) : [] }) };
	});
	r.get("/api/w/:ws/projects/:p", async (req) => {
		const { ws } = await member(req);
		return await ws.projects.snapshot(req.params.p!);
	});
	r.patch("/api/w/:ws/projects/:p", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { model, applyToAgents } = await req.body();
		if (model) await ws.projects.setProjectModel(req.params.p!, { provider: String(model.provider), modelId: String(model.modelId) }, user, !!applyToAgents);
		return { ok: true };
	});
	r.patch("/api/w/:ws/projects/:p/agents/:key", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { model } = await req.body();
		if (!model) throw new HttpError(400, "Nothing to change");
		await ws.projects.meta(req.params.p!);
		await ws.projects.setAgentModel(req.params.p!, req.params.key!, { provider: String(model.provider), modelId: String(model.modelId) }, user);
		return { ok: true };
	});
	r.delete("/api/w/:ws/projects/:p", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.projects.archive(req.params.p!);
		return { ok: true };
	});
	r.post("/api/w/:ws/projects/:p/stop", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.projects.stopAll(req.params.p!);
		return { ok: true };
	});
	// Document gates (M2): requirements and design.
	r.post("/api/w/:ws/projects/:p/gates/:gate/approve", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { comment } = await req.body();
		await ws.projects.meta(req.params.p!);
		const gate = req.params.gate === "design" ? "design" : req.params.gate === "requirements" ? "requirements" : undefined;
		if (!gate) throw new HttpError(404, "No such gate");
		await ws.projects.approveGate(req.params.p!, gate, user, comment ? String(comment) : undefined);
		return { ok: true };
	});
	r.post("/api/w/:ws/projects/:p/gates/:gate/changes", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { comment } = await req.body();
		await ws.projects.meta(req.params.p!);
		const gate = req.params.gate === "design" ? "design" : req.params.gate === "requirements" ? "requirements" : undefined;
		if (!gate) throw new HttpError(404, "No such gate");
		await ws.projects.gateChanges(req.params.p!, gate, user, String(comment ?? ""));
		return { ok: true };
	});
	// Questions: blocking flag, dismiss (answering is a message to the agent, above).
	r.patch("/api/w/:ws/projects/:p/questions/:id", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { blocking } = await req.body();
		await ws.projects.meta(req.params.p!);
		if (typeof blocking !== "boolean") throw new HttpError(400, "blocking: true or false");
		await ws.projects.setQuestionBlocking(req.params.p!, req.params.id!, blocking, user);
		return { ok: true };
	});
	r.post("/api/w/:ws/projects/:p/questions/:id/dismiss", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { note } = await req.body();
		await ws.projects.meta(req.params.p!);
		await ws.projects.dismissQuestion(req.params.p!, req.params.id!, user, note ? String(note).slice(0, 2000) : undefined);
		return { ok: true };
	});
	// Feedback on the running app, and approval of what the team drafts from it.
	r.post("/api/w/:ws/projects/:p/feedback", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { text, files } = await req.body();
		await ws.projects.meta(req.params.p!);
		return { feedback: await ws.projects.addFeedback(req.params.p!, user, String(text ?? "").slice(0, 8000), Array.isArray(files) ? files.map(String) : []) };
	});
	r.post("/api/w/:ws/projects/:p/feedback/:id/pbi", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { title, description, acceptance, parent } = await req.body();
		await ws.projects.meta(req.params.p!);
		return { item: await ws.projects.pbiFromFeedback(req.params.p!, req.params.id!, user, { title: String(title ?? ""), description: description ? String(description) : undefined, acceptance: Array.isArray(acceptance) ? acceptance.map(String) : undefined, parent: parent ? String(parent) : undefined }) };
	});
	r.post("/api/w/:ws/projects/:p/feedback/:id/decline", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { reason } = await req.body();
		await ws.projects.meta(req.params.p!);
		return { removed: await ws.projects.declineFeedback(req.params.p!, req.params.id!, { name: user.displayName, user }, String(reason ?? "")) };
	});
	r.post("/api/w/:ws/projects/:p/feedback/:id/reopen", async (req) => {
		const { user, ws } = await member(req, "editor");
		await ws.projects.meta(req.params.p!);
		await ws.projects.reopenFeedback(req.params.p!, req.params.id!, user);
		return { ok: true };
	});
	r.post("/api/w/:ws/projects/:p/backlog/approve-pending", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { feedback } = await req.body();
		await ws.projects.meta(req.params.p!);
		return { approved: await ws.projects.approvePending(req.params.p!, user, feedback ? String(feedback) : undefined) };
	});
	r.post("/api/w/:ws/projects/:p/backlog/pending-changes", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { comment, feedback } = await req.body();
		await ws.projects.meta(req.params.p!);
		await ws.projects.pendingChanges(req.params.p!, user, String(comment ?? ""), feedback ? String(feedback) : undefined);
		return { ok: true };
	});
	// Build (milestone 4): pause/resume assignments.
	r.post("/api/w/:ws/projects/:p/build", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { paused } = await req.body();
		await ws.projects.meta(req.params.p!);
		await ws.projects.build.setPaused(req.params.p!, !!paused, user.displayName);
		return { ok: true };
	});
	// Live preview (milestone 5).
	r.get("/api/w/:ws/projects/:p/preview", async (req) => {
		const { ws } = await member(req, "viewer");
		await ws.projects.meta(req.params.p!);
		return { preview: ws.projects.previews.info(req.params.p!) };
	});
	r.post("/api/w/:ws/projects/:p/preview/start", async (req) => {
		const { user, ws } = await member(req, "editor");
		await ws.projects.meta(req.params.p!);
		void ws.projects.previews.start(req.params.p!, `started by ${user.displayName}`).catch(() => {});
		return { ok: true };
	});
	r.post("/api/w/:ws/projects/:p/preview/stop", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.projects.meta(req.params.p!);
		await ws.projects.previews.stop(req.params.p!, true);
		return { ok: true };
	});
	r.get("/api/w/:ws/projects/:p/preview/logs", async (req) => {
		const { ws } = await member(req, "viewer");
		await ws.projects.meta(req.params.p!);
		return ws.projects.previews.logs(req.params.p!, Number(req.query.get("since") ?? 0) || 0);
	});
	// Backlog: the user's side of the approval gate, and edits from the board.
	r.post("/api/w/:ws/projects/:p/backlog/approve", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { comment } = await req.body();
		await ws.projects.meta(req.params.p!);
		await ws.projects.approveBacklog(req.params.p!, user, comment ? String(comment) : undefined);
		return { ok: true };
	});
	r.post("/api/w/:ws/projects/:p/backlog/changes", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { comment } = await req.body();
		if (!String(comment ?? "").trim()) throw new HttpError(400, "Say what should change");
		await ws.projects.meta(req.params.p!);
		await ws.projects.requestBacklogChanges(req.params.p!, user, String(comment));
		return { ok: true };
	});
	r.patch("/api/w/:ws/projects/:p/backlog/:id", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { title, description, status, assignee, estimate, area, acceptance } = await req.body();
		await ws.projects.meta(req.params.p!);
		await ws.projects.updateItem(req.params.p!, req.params.id!, { title, description, status, assignee, estimate, area, acceptance: Array.isArray(acceptance) ? acceptance.map(String) : undefined }, user);
		return { ok: true };
	});
	r.delete("/api/w/:ws/projects/:p/backlog/:id", async (req) => {
		const { user, ws } = await member(req, "editor");
		await ws.projects.meta(req.params.p!);
		await ws.projects.removeItem(req.params.p!, req.params.id!, user);
		return { ok: true };
	});
	r.post("/api/w/:ws/projects/:p/agents/:key/messages", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { text, files, questionId } = await req.body();
		const fileIds = Array.isArray(files) ? files.map(String) : [];
		if (!String(text ?? "").trim() && !fileIds.length) throw new HttpError(400, "Empty message");
		await ws.projects.meta(req.params.p!);
		await ws.projects.userMessage(req.params.p!, req.params.key!, user, String(text ?? ""), fileIds, questionId ? String(questionId) : undefined);
		return { ok: true };
	});
	r.get("/api/w/:ws/projects/:p/files", async (req) => {
		const { ws } = await member(req);
		await ws.projects.meta(req.params.p!);
		const repo = ws.projects.repo(req.params.p!);
		return { files: await repo.files(), head: await repo.head() };
	});
	r.get("/api/w/:ws/projects/:p/file", async (req) => {
		const { ws } = await member(req);
		await ws.projects.meta(req.params.p!);
		const file = await ws.projects.repo(req.params.p!).read(String(req.query.get("path") ?? ""));
		if (!file) throw new HttpError(404, "Not on main yet");
		return file;
	});
	r.get("/api/w/:ws/projects/:p/log", async (req) => {
		const { ws } = await member(req);
		await ws.projects.meta(req.params.p!);
		return { log: await ws.projects.repo(req.params.p!).log() };
	});

	// ------------------------------------------------------------ gadgets
	r.get("/api/w/:ws/gadgets", async (req) => {
		const { role } = await member(req);
		return { gadgets: gadgets.inWorkspace(req.params.ws!).map((g) => gadgetView(g, role)) };
	});
	r.post("/api/w/:ws/gadgets", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { name, blueprintId, icon } = await req.body();
		const g = await ws.createGadget({ name: String(name || "Untitled").slice(0, 80), blueprintId, icon, ownerId: user.id });
		return { gadget: gadgetView(g, "owner") };
	});
	r.get("/api/shared", (req) => ({ gadgets: gadgets.sharedWith(req.need().id).map((g) => gadgetView(g, g.role)) }));
	r.get("/api/gadgets/:id", async (req) => {
		const user = req.need();
		const { gadget, role, ws } = await Workspace.gadgetFor(req.params.id!, user);
		const isEditor = ROLE_RANK[role] >= 2;
		return {
			gadget: gadgetView(gadget, role),
			files: isEditor ? await ws.gadgetFiles(gadget.id) : undefined,
			server: await ws.host(gadget.id).describe(),
			shares: role === "owner" ? gadgets.shares(gadget.id) : undefined,
			links: role === "owner" ? gadgets.links(gadget.id) : undefined,
		};
	});
	r.patch("/api/gadgets/:id", async (req) => {
		const { gadget, ws } = await Workspace.gadgetFor(req.params.id!, req.need(), "editor");
		const { name, icon } = await req.body();
		gadgets.touch(gadget.id, { name, icon });
		ws.publishGadgets();
		return { ok: true };
	});
	r.put("/api/gadgets/:id/files", async (req) => {
		const { gadget, ws } = await Workspace.gadgetFor(req.params.id!, req.need(), "editor");
		const { path, content } = await req.body();
		await ws.writeGadgetFiles(gadget.id, { [String(path)]: content === null ? null : String(content) });
		return { server: await ws.host(gadget.id).describe() };
	});
	r.delete("/api/gadgets/:id", async (req) => {
		const { gadget, ws } = await Workspace.gadgetFor(req.params.id!, req.need(), "owner");
		await ws.deleteGadget(gadget.id);
		return { ok: true };
	});
	r.get("/api/gadgets/:id/logs", async (req) => {
		const { gadget, ws } = await Workspace.gadgetFor(req.params.id!, req.need(), "editor");
		return { lines: await ws.gadgetLogs(gadget.id) };
	});
	r.get("/api/gadgets/:id/state", async (req) => {
		const { gadget, ws } = await Workspace.gadgetFor(req.params.id!, req.need(), "editor");
		return { kv: await ws.gadgetState(gadget.id) };
	});
	r.post("/api/gadgets/:id/frame-token", async (req) => {
		const user = req.need();
		const { gadget, role } = await Workspace.gadgetFor(req.params.id!, user);
		return { token: sign({ g: gadget.id, u: user.id, n: user.displayName, r: role }, 10 * 60_000) };
	});
	r.post("/api/gadgets/:id/shares", async (req) => {
		const { gadget } = await Workspace.gadgetFor(req.params.id!, req.need(), "owner");
		const { username, role } = await req.body();
		const target = users.byUsername(String(username));
		if (!target) throw new HttpError(404, `No user "${username}"`);
		gadgets.share(gadget.id, target.id, role === null ? null : asRole(role));
		hub.publish(`user:${target.id}`, { t: "shared.changed" });
		return { shares: gadgets.shares(gadget.id) };
	});
	r.post("/api/gadgets/:id/links", async (req) => {
		const user = req.need();
		const { gadget } = await Workspace.gadgetFor(req.params.id!, user, "owner");
		const { role } = await req.body();
		gadgets.createLink(gadget.id, asRole(role ?? "viewer") === "owner" ? "editor" : asRole(role ?? "viewer"), user.id);
		return { links: gadgets.links(gadget.id) };
	});
	r.delete("/api/gadgets/:id/links/:token", async (req) => {
		const { gadget } = await Workspace.gadgetFor(req.params.id!, req.need(), "owner");
		gadgets.deleteLink(req.params.token!);
		return { links: gadgets.links(gadget.id) };
	});
	r.post("/api/links/:token/accept", async (req) => {
		const user = req.need();
		const link = gadgets.link(req.params.token!);
		if (!link) throw new HttpError(404, "This link is no longer valid");
		const g = gadgets.get(link.gadgetId)!;
		const current = gadgets.role(g, user.id);
		if (!current || ROLE_RANK[current] < ROLE_RANK[link.role]) gadgets.share(g.id, user.id, link.role);
		return { gadgetId: g.id };
	});

	// ------------------------------------------------------------ blueprints
	r.get("/api/blueprints", (req) => {
		const user = req.need();
		return {
			blueprints: blueprints.visibleTo(user.id).map(({ files, ...b }) => ({ ...b, author: b.authorId ? users.get(b.authorId)?.displayName : "pi-os", fileCount: Object.keys(files).length, mine: b.authorId === user.id })),
		};
	});
	r.post("/api/blueprints", async (req) => {
		const user = req.need();
		const { gadgetId, name, description, visibility } = await req.body();
		const { gadget, ws } = await Workspace.gadgetFor(String(gadgetId), user, "editor");
		const bp = await ws.publishBlueprint(gadget.id, { name: String(name || gadget.name), description: String(description ?? ""), visibility: visibility === "private" ? "private" : "public", authorId: user.id });
		return { blueprint: { id: bp.id } };
	});
	// ------------------------------------------------------------ export / import (move between instances)
	r.get("/api/blueprints/:id/export", (req) => {
		const user = req.need();
		const bp = blueprints.get(req.params.id!);
		if (!bp || (bp.visibility !== "public" && bp.authorId !== user.id)) throw new HttpError(404, "No such blueprint");
		const bundle = makeBundle({ blueprints: [bp] });
		return { fileName: bundleFileName(bundle), bundle };
	});
	r.get("/api/gadgets/:id/export", async (req) => {
		const { gadget, ws } = await Workspace.gadgetFor(req.params.id!, req.need(), "editor");
		const withData = req.query.get("data") === "1";
		const bundle = makeBundle({ gadgets: [{ row: gadget, files: await ws.gadgetFiles(gadget.id), data: withData ? await ws.gadgetState(gadget.id) : undefined }] });
		return { fileName: bundleFileName(bundle), bundle };
	});
	/** Bulk: ?blueprints=mine and/or ?gadgets=all (this workspace), &data=1 for gadget data. */
	r.get("/api/w/:ws/export", async (req) => {
		const { user, ws } = await member(req, "editor");
		const withData = req.query.get("data") === "1";
		const bps = req.query.get("blueprints") === "mine" ? blueprints.visibleTo(user.id).filter((b) => b.authorId === user.id) : [];
		const gs = req.query.get("gadgets") === "all" ? gadgets.inWorkspace(ws.id) : [];
		if (!bps.length && !gs.length) throw new HttpError(400, "Nothing to export");
		const bundle = makeBundle({ blueprints: bps, gadgets: await Promise.all(gs.map(async (g) => ({ row: g, files: await ws.gadgetFiles(g.id), data: withData ? await ws.gadgetState(g.id) : undefined }))) });
		return { fileName: bundleFileName(bundle), bundle };
	});
	/** Body: a bundle. Blueprints go to the user's library, gadgets into this workspace. ?visibility=public shares imported blueprints. */
	r.post("/api/w/:ws/import", async (req) => {
		const { user, ws } = await member(req, "editor");
		const raw = await readRaw(req, config.maxUploadBytes);
		let json: unknown;
		try {
			json = JSON.parse(raw.toString("utf8"));
		} catch {
			throw new HttpError(400, "Not a pi-os export file (it isn't JSON)");
		}
		const result = await importBundle(ws, user.id, parseBundle(json), { visibility: req.query.get("visibility") === "public" ? "public" : "private" });
		if (result.blueprints.length) hub.publish("blueprints", { t: "blueprints.changed" });
		return result;
	});
	r.delete("/api/blueprints/:id", (req) => {
		const user = req.need();
		const bp = blueprints.get(req.params.id!);
		if (!bp || bp.authorId !== user.id) throw new HttpError(403, "Only the author can delete a blueprint");
		blueprints.delete(bp.id);
		return { ok: true };
	});

	// ------------------------------------------------------------ gatekeepers
	r.get("/api/gatekeepers", (req) => {
		req.need();
		return { gatekeepers: Object.values(GATEKEEPERS).map(describeGatekeeper), githubToken: !!config.githubToken() };
	});
	r.post("/api/w/:ws/grants", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { gatekeeper, resource, label, holder, autoApprove, requestId } = await req.body();
		if (!holder || !["conversation", "gadget"].includes(holder.kind)) throw new HttpError(400, "holder must be {kind: conversation|gadget, id}");
		return { grant: await ws.grant({ gatekeeper, resource: String(resource ?? ""), label, holder, autoApprove, by: user.displayName, requestId }) };
	});
	r.patch("/api/w/:ws/grants/:id", async (req) => {
		const { ws } = await member(req, "editor");
		const { autoApprove } = await req.body();
		await ws.harness.commit(async (tx) => {
			const { GrantsDoc } = await import("../kernel/docs.ts");
			const g = (await tx.doc(GrantsDoc)).grants[req.params.id!];
			if (g) g.autoApprove = !!autoApprove;
		}, ctx);
		return { ok: true };
	});
	r.delete("/api/w/:ws/grants/:id", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.revoke(req.params.id!);
		return { ok: true };
	});
	r.post("/api/w/:ws/requests/:id/deny", async (req) => {
		const { user, ws } = await member(req, "editor");
		await ws.denyRequest(req.params.id!, user.displayName);
		return { ok: true };
	});
	r.post("/api/w/:ws/approvals/:id/:decision", async (req) => {
		const { user, ws } = await member(req, "editor");
		const approve = req.params.decision === "approve";
		if (!approve && req.params.decision !== "reject") throw new HttpError(400, "approve or reject");
		return await ws.decide(req.params.id!, approve, user.displayName);
	});

	// ------------------------------------------------------------ gadget frame (sandboxed origin)
	r.get("/frame/:id", async (req) => {
		const claims = verify<{ g: string; u: string; n: string; r: Role }>(req.query.get("t") ?? undefined);
		if (!claims || claims.g !== req.params.id) throw new HttpError(403, "Frame token expired — reload the gadget");
		const g = gadgets.get(claims.g);
		if (!g) throw new HttpError(404, "No such gadget");
		const ws = await Workspace.get(g.workspaceId);
		const html = buildFrame(await ws.gadgetFiles(g.id), { gadgetId: g.id, user: { id: claims.u, name: claims.n, role: claims.r } });
		req.res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": `${FRAME_CSP}; sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups`,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			"cross-origin-resource-policy": "same-origin",
		});
		req.res.end(html);
	});

	return r;
}
