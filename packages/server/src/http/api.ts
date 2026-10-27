import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { config } from "../config.ts";
import { describeAirlock, AIRLOCKS } from "../airlocks/catalog.ts";
import { CONNECTOR_INFO } from "../airlocks/connectors/types.ts";
import { buildFrame, FRAME_CSP } from "../modules/frame.ts";
import { bundleFileName, checkBundle, importBundle, makeBundle, parseBundle } from "../modules/bundle.ts";
import { capabilities } from "../modules/compat.ts";
import { credentials, defaultModel, listModels, listProviders, models } from "../kernel/models.ts";
import { home, markSeen, summarize } from "../kernel/home.ts";
import { oauthLogins } from "../kernel/oauth.ts";
import { blueprints, modules, HttpError, sessions, sign, users, verify, workspaces, ROLE_RANK, type Role, type User } from "../kernel/system-db.ts";
import { Workspace } from "../kernel/workspace.ts";
import { hub } from "../collab/hub.ts";
import { readRaw, Router, type Req } from "./util.ts";

const cookie = (token: string, maxAge: number) => `outpost_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
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

function moduleView(g: ReturnType<typeof modules.get> & {}, role: Role) {
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
		const token = /outpost_session=([^;]+)/.exec(req.raw.headers.cookie ?? "")?.[1];
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
		if (credentials.managedByConfig(req.params.id!)) throw new HttpError(409, `The ${req.params.id} key is set in outpost.config.json; change it there.`);
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

	// ------------------------------------------------------------ homepage
	/** What you were doing, and what happened while you were away. No model calls: the page loads instantly. */
	r.get("/api/w/:ws/home", async (req) => {
		const { user, ws } = await member(req);
		return await home(ws, user);
	});
	/** Mark the homepage as read; the next visit measures from this moment. */
	r.post("/api/w/:ws/home/seen", async (req) => {
		const { user, ws } = await member(req);
		return { since: markSeen(ws, user) };
	});
	/** One model-written line per chat, cached until that chat has newer runs. */
	r.post("/api/w/:ws/home/summaries", async (req) => {
		const { user, ws } = await member(req);
		const { chats } = await req.body();
		return await summarize(ws, user, Array.isArray(chats) ? chats.map(String) : []);
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
		const { content, mode, files, module } = await req.body();
		const fileIds = Array.isArray(files) ? files.map(String).slice(0, 20) : [];
		if (!String(content ?? "").trim() && !fileIds.length) throw new HttpError(400, "Empty message");
		return { submission: await ws.send(req.params.chat!, user, String(content ?? ""), mode === "steer" ? "steer" : "followUp", fileIds, typeof module === "string" ? module : undefined) };
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
		const { name, modules: allow } = await req.body();
		await ws.files.get(req.params.id!);
		await ws.files.update(req.params.id!, (m) => {
			if (typeof name === "string" && name.trim()) m.name = name.trim().slice(0, 240);
			if (Array.isArray(allow)) m.modules = allow.map(String).filter((g) => modules.get(g)?.workspaceId === ws.id);
		});
		return { ok: true };
	});
	r.delete("/api/w/:ws/files/:id", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.files.delete(req.params.id!);
		return { ok: true };
	});

	// ------------------------------------------------------------ missions (agent teams)
	r.get("/api/w/:ws/missions", async (req) => {
		const { ws } = await member(req);
		return { missions: await ws.missions.list() };
	});
	r.post("/api/w/:ws/missions", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { goal, name, model, files } = await req.body();
		const chosen = model?.provider && model?.modelId ? { provider: String(model.provider), modelId: String(model.modelId) } : await defaultModel(ws.row.settings.defaultModel, users.prefs(user.id).modelPicker);
		return { mission: await ws.missions.create(user, { goal: String(goal ?? ""), name: name ? String(name).slice(0, 80) : undefined, model: chosen, files: Array.isArray(files) ? files.map(String) : [] }) };
	});
	r.get("/api/w/:ws/missions/:p", async (req) => {
		const { ws } = await member(req);
		return await ws.missions.snapshot(req.params.p!);
	});
	r.patch("/api/w/:ws/missions/:p", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { model, applyToAgents } = await req.body();
		if (model) await ws.missions.setMissionModel(req.params.p!, { provider: String(model.provider), modelId: String(model.modelId) }, user, !!applyToAgents);
		return { ok: true };
	});
	r.patch("/api/w/:ws/missions/:p/agents/:key", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { model } = await req.body();
		if (!model) throw new HttpError(400, "Nothing to change");
		await ws.missions.meta(req.params.p!);
		await ws.missions.setAgentModel(req.params.p!, req.params.key!, { provider: String(model.provider), modelId: String(model.modelId) }, user);
		return { ok: true };
	});
	r.delete("/api/w/:ws/missions/:p", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.missions.archive(req.params.p!);
		return { ok: true };
	});
	r.post("/api/w/:ws/missions/:p/stop", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.missions.stopAll(req.params.p!);
		return { ok: true };
	});
	// Document gates (M2): requirements and design.
	r.post("/api/w/:ws/missions/:p/gates/:gate/approve", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { comment } = await req.body();
		await ws.missions.meta(req.params.p!);
		const gate = req.params.gate === "design" ? "design" : req.params.gate === "requirements" ? "requirements" : undefined;
		if (!gate) throw new HttpError(404, "No such gate");
		await ws.missions.approveGate(req.params.p!, gate, user, comment ? String(comment) : undefined);
		return { ok: true };
	});
	r.post("/api/w/:ws/missions/:p/gates/:gate/changes", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { comment } = await req.body();
		await ws.missions.meta(req.params.p!);
		const gate = req.params.gate === "design" ? "design" : req.params.gate === "requirements" ? "requirements" : undefined;
		if (!gate) throw new HttpError(404, "No such gate");
		await ws.missions.gateChanges(req.params.p!, gate, user, String(comment ?? ""));
		return { ok: true };
	});
	// Questions: blocking flag, dismiss (answering is a message to the agent, above).
	r.patch("/api/w/:ws/missions/:p/questions/:id", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { blocking } = await req.body();
		await ws.missions.meta(req.params.p!);
		if (typeof blocking !== "boolean") throw new HttpError(400, "blocking: true or false");
		await ws.missions.setQuestionBlocking(req.params.p!, req.params.id!, blocking, user);
		return { ok: true };
	});
	r.post("/api/w/:ws/missions/:p/questions/:id/dismiss", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { note } = await req.body();
		await ws.missions.meta(req.params.p!);
		await ws.missions.dismissQuestion(req.params.p!, req.params.id!, user, note ? String(note).slice(0, 2000) : undefined);
		return { ok: true };
	});
	// Feedback on the running app, and approval of what the team drafts from it.
	r.post("/api/w/:ws/missions/:p/feedback", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { text, files } = await req.body();
		await ws.missions.meta(req.params.p!);
		return { feedback: await ws.missions.addFeedback(req.params.p!, user, String(text ?? "").slice(0, 8000), Array.isArray(files) ? files.map(String) : []) };
	});
	r.post("/api/w/:ws/missions/:p/feedback/:id/pbi", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { title, description, acceptance, parent } = await req.body();
		await ws.missions.meta(req.params.p!);
		return { item: await ws.missions.pbiFromFeedback(req.params.p!, req.params.id!, user, { title: String(title ?? ""), description: description ? String(description) : undefined, acceptance: Array.isArray(acceptance) ? acceptance.map(String) : undefined, parent: parent ? String(parent) : undefined }) };
	});
	r.post("/api/w/:ws/missions/:p/feedback/:id/decline", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { reason } = await req.body();
		await ws.missions.meta(req.params.p!);
		return { removed: await ws.missions.declineFeedback(req.params.p!, req.params.id!, { name: user.displayName, user }, String(reason ?? "")) };
	});
	r.post("/api/w/:ws/missions/:p/feedback/:id/reopen", async (req) => {
		const { user, ws } = await member(req, "editor");
		await ws.missions.meta(req.params.p!);
		await ws.missions.reopenFeedback(req.params.p!, req.params.id!, user);
		return { ok: true };
	});
	r.post("/api/w/:ws/missions/:p/backlog/approve-pending", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { feedback } = await req.body();
		await ws.missions.meta(req.params.p!);
		return { approved: await ws.missions.approvePending(req.params.p!, user, feedback ? String(feedback) : undefined) };
	});
	r.post("/api/w/:ws/missions/:p/backlog/pending-changes", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { comment, feedback } = await req.body();
		await ws.missions.meta(req.params.p!);
		await ws.missions.pendingChanges(req.params.p!, user, String(comment ?? ""), feedback ? String(feedback) : undefined);
		return { ok: true };
	});
	// Build (milestone 4): pause/resume assignments.
	r.post("/api/w/:ws/missions/:p/build", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { paused } = await req.body();
		await ws.missions.meta(req.params.p!);
		await ws.missions.build.setPaused(req.params.p!, !!paused, user.displayName);
		return { ok: true };
	});
	// Live preview (milestone 5).
	r.get("/api/w/:ws/missions/:p/preview", async (req) => {
		const { ws } = await member(req, "viewer");
		await ws.missions.meta(req.params.p!);
		return { preview: ws.missions.previews.info(req.params.p!) };
	});
	r.post("/api/w/:ws/missions/:p/preview/start", async (req) => {
		const { user, ws } = await member(req, "editor");
		await ws.missions.meta(req.params.p!);
		void ws.missions.previews.start(req.params.p!, `started by ${user.displayName}`).catch(() => {});
		return { ok: true };
	});
	r.post("/api/w/:ws/missions/:p/preview/stop", async (req) => {
		const { ws } = await member(req, "editor");
		await ws.missions.meta(req.params.p!);
		await ws.missions.previews.stop(req.params.p!, true);
		return { ok: true };
	});
	r.get("/api/w/:ws/missions/:p/preview/logs", async (req) => {
		const { ws } = await member(req, "viewer");
		await ws.missions.meta(req.params.p!);
		return ws.missions.previews.logs(req.params.p!, Number(req.query.get("since") ?? 0) || 0);
	});
	// Backlog: the user's side of the approval gate, and edits from the board.
	r.post("/api/w/:ws/missions/:p/backlog/approve", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { comment } = await req.body();
		await ws.missions.meta(req.params.p!);
		await ws.missions.approveBacklog(req.params.p!, user, comment ? String(comment) : undefined);
		return { ok: true };
	});
	r.post("/api/w/:ws/missions/:p/backlog/changes", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { comment } = await req.body();
		if (!String(comment ?? "").trim()) throw new HttpError(400, "Say what should change");
		await ws.missions.meta(req.params.p!);
		await ws.missions.requestBacklogChanges(req.params.p!, user, String(comment));
		return { ok: true };
	});
	r.patch("/api/w/:ws/missions/:p/backlog/:id", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { title, description, status, assignee, estimate, area, acceptance } = await req.body();
		await ws.missions.meta(req.params.p!);
		await ws.missions.updateItem(req.params.p!, req.params.id!, { title, description, status, assignee, estimate, area, acceptance: Array.isArray(acceptance) ? acceptance.map(String) : undefined }, user);
		return { ok: true };
	});
	r.delete("/api/w/:ws/missions/:p/backlog/:id", async (req) => {
		const { user, ws } = await member(req, "editor");
		await ws.missions.meta(req.params.p!);
		await ws.missions.removeItem(req.params.p!, req.params.id!, user);
		return { ok: true };
	});
	r.post("/api/w/:ws/missions/:p/agents/:key/messages", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { text, files, questionId } = await req.body();
		const fileIds = Array.isArray(files) ? files.map(String) : [];
		if (!String(text ?? "").trim() && !fileIds.length) throw new HttpError(400, "Empty message");
		await ws.missions.meta(req.params.p!);
		await ws.missions.userMessage(req.params.p!, req.params.key!, user, String(text ?? ""), fileIds, questionId ? String(questionId) : undefined);
		return { ok: true };
	});
	r.get("/api/w/:ws/missions/:p/files", async (req) => {
		const { ws } = await member(req);
		await ws.missions.meta(req.params.p!);
		const repo = ws.missions.repo(req.params.p!);
		return { files: await repo.files(), head: await repo.head() };
	});
	r.get("/api/w/:ws/missions/:p/file", async (req) => {
		const { ws } = await member(req);
		await ws.missions.meta(req.params.p!);
		const file = await ws.missions.repo(req.params.p!).read(String(req.query.get("path") ?? ""));
		if (!file) throw new HttpError(404, "Not on main yet");
		return file;
	});
	r.get("/api/w/:ws/missions/:p/log", async (req) => {
		const { ws } = await member(req);
		await ws.missions.meta(req.params.p!);
		return { log: await ws.missions.repo(req.params.p!).log() };
	});

	// ------------------------------------------------------------ modules
	r.get("/api/w/:ws/modules", async (req) => {
		const { role } = await member(req);
		return { modules: modules.inWorkspace(req.params.ws!).map((g) => moduleView(g, role)), archived: modules.archived(req.params.ws!).map((g) => moduleView(g, role)) };
	});
	r.post("/api/w/:ws/modules", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { name, blueprintId, icon } = await req.body();
		const g = await ws.createModule({ name: String(name || "Untitled").slice(0, 80), blueprintId, icon, ownerId: user.id });
		return { module: moduleView(g, "owner") };
	});
	r.get("/api/shared", (req) => ({ modules: modules.sharedWith(req.need().id).map((g) => moduleView(g, g.role)) }));
	r.get("/api/modules/:id", async (req) => {
		const user = req.need();
		const { module, role, ws } = await Workspace.moduleFor(req.params.id!, user);
		const isEditor = ROLE_RANK[role] >= 2;
		return {
			module: moduleView(module, role),
			files: isEditor ? await ws.moduleFiles(module.id) : undefined,
			server: await ws.host(module.id).describe(),
			shares: role === "owner" ? modules.shares(module.id) : undefined,
			links: role === "owner" ? modules.links(module.id) : undefined,
		};
	});
	r.patch("/api/modules/:id", async (req) => {
		const { module, ws } = await Workspace.moduleFor(req.params.id!, req.need(), "editor");
		const { name, icon, archived } = await req.body();
		if (name !== undefined || icon !== undefined) modules.touch(module.id, { ...(name !== undefined ? { name: String(name).slice(0, 120) } : {}), ...(icon ? { icon: String(icon).slice(0, 8) } : {}) });
		if (typeof archived === "boolean") modules.setArchived(module.id, archived);
		ws.publishModules();
		return { ok: true };
	});
	r.put("/api/modules/:id/files", async (req) => {
		const { module, ws } = await Workspace.moduleFor(req.params.id!, req.need(), "editor");
		const { path, content } = await req.body();
		await ws.writeModuleFiles(module.id, { [String(path)]: content === null ? null : String(content) });
		return { server: await ws.host(module.id).describe() };
	});
	r.delete("/api/modules/:id", async (req) => {
		const { module, ws } = await Workspace.moduleFor(req.params.id!, req.need(), "owner");
		await ws.deleteModule(module.id);
		return { ok: true };
	});
	r.get("/api/modules/:id/logs", async (req) => {
		const { module, ws } = await Workspace.moduleFor(req.params.id!, req.need(), "editor");
		return { lines: await ws.moduleLogs(module.id) };
	});
	r.get("/api/modules/:id/state", async (req) => {
		const { module, ws } = await Workspace.moduleFor(req.params.id!, req.need(), "editor");
		return { kv: await ws.moduleState(module.id) };
	});
	r.post("/api/modules/:id/frame-token", async (req) => {
		const user = req.need();
		const { module, role } = await Workspace.moduleFor(req.params.id!, user);
		return { token: sign({ g: module.id, u: user.id, n: user.displayName, r: role }, 10 * 60_000) };
	});
	r.post("/api/modules/:id/shares", async (req) => {
		const { module } = await Workspace.moduleFor(req.params.id!, req.need(), "owner");
		const { username, role } = await req.body();
		const target = users.byUsername(String(username));
		if (!target) throw new HttpError(404, `No user "${username}"`);
		modules.share(module.id, target.id, role === null ? null : asRole(role));
		hub.publish(`user:${target.id}`, { t: "shared.changed" });
		return { shares: modules.shares(module.id) };
	});
	r.post("/api/modules/:id/links", async (req) => {
		const user = req.need();
		const { module } = await Workspace.moduleFor(req.params.id!, user, "owner");
		const { role } = await req.body();
		modules.createLink(module.id, asRole(role ?? "viewer") === "owner" ? "editor" : asRole(role ?? "viewer"), user.id);
		return { links: modules.links(module.id) };
	});
	r.delete("/api/modules/:id/links/:token", async (req) => {
		const { module } = await Workspace.moduleFor(req.params.id!, req.need(), "owner");
		modules.deleteLink(req.params.token!);
		return { links: modules.links(module.id) };
	});
	r.post("/api/links/:token/accept", async (req) => {
		const user = req.need();
		const link = modules.link(req.params.token!);
		if (!link) throw new HttpError(404, "This link is no longer valid");
		const g = modules.get(link.moduleId)!;
		const current = modules.role(g, user.id);
		if (!current || ROLE_RANK[current] < ROLE_RANK[link.role]) modules.share(g.id, user.id, link.role);
		return { moduleId: g.id };
	});

	// ------------------------------------------------------------ blueprints
	r.get("/api/blueprints", (req) => {
		const user = req.need();
		return {
			blueprints: blueprints.visibleTo(user.id).map(({ files, ...b }) => ({ ...b, author: b.authorId ? users.get(b.authorId)?.displayName : "outpost", fileCount: Object.keys(files).length, mine: b.authorId === user.id })),
		};
	});
	r.post("/api/blueprints", async (req) => {
		const user = req.need();
		const { moduleId, name, description, visibility } = await req.body();
		const { module, ws } = await Workspace.moduleFor(String(moduleId), user, "editor");
		const bp = await ws.publishBlueprint(module.id, { name: String(name || module.name), description: String(description ?? ""), visibility: visibility === "private" ? "private" : "public", authorId: user.id });
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
	r.get("/api/modules/:id/export", async (req) => {
		const { module, ws } = await Workspace.moduleFor(req.params.id!, req.need(), "editor");
		const withData = req.query.get("data") === "1";
		const bundle = makeBundle({ modules: [{ row: module, files: await ws.moduleFiles(module.id), data: withData ? await ws.moduleState(module.id) : undefined, grants: await ws.moduleGrants(module.id) }] });
		return { fileName: bundleFileName(bundle), bundle };
	});
	/** Bulk: ?blueprints=mine and/or ?modules=all (this workspace), &data=1 for module data. */
	r.get("/api/w/:ws/export", async (req) => {
		const { user, ws } = await member(req, "editor");
		const withData = req.query.get("data") === "1";
		const bps = req.query.get("blueprints") === "mine" ? blueprints.visibleTo(user.id).filter((b) => b.authorId === user.id) : [];
		const gs = req.query.get("modules") === "all" ? modules.inWorkspace(ws.id) : [];
		if (!bps.length && !gs.length) throw new HttpError(400, "Nothing to export");
		const bundle = makeBundle({ blueprints: bps, modules: await Promise.all(gs.map(async (g) => ({ row: g, files: await ws.moduleFiles(g.id), data: withData ? await ws.moduleState(g.id) : undefined, grants: await ws.moduleGrants(g.id) }))) });
		return { fileName: bundleFileName(bundle), bundle };
	});
	/** What this instance can run: its version, the module runtime, features and Airlocks. */
	r.get("/api/capabilities", (req) => (req.need(), capabilities()));
	const readBundle = async (req: Req) => {
		const raw = await readRaw(req, config.maxUploadBytes);
		try {
			return parseBundle(JSON.parse(raw.toString("utf8")));
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new HttpError(400, "Not a outpost export file (it isn't JSON)");
		}
	};
	/** Body: a bundle. Reports, per item, whether it can run here (ok / warn / blocked) without importing. */
	r.post("/api/w/:ws/import/check", async (req) => {
		await member(req, "editor");
		return checkBundle(await readBundle(req));
	});
	/** Body: a bundle. Blueprints go to the user's library, modules into this workspace; items that can't run here are skipped. ?visibility=public shares imported blueprints. */
	r.post("/api/w/:ws/import", async (req) => {
		const { user, ws } = await member(req, "editor");
		const result = await importBundle(ws, user.id, await readBundle(req), { visibility: req.query.get("visibility") === "public" ? "public" : "private" });
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

	// ------------------------------------------------------------ airlocks
	r.get("/api/airlocks", (req) => {
		req.need();
		return { airlocks: Object.values(AIRLOCKS).map(describeAirlock), githubToken: !!config.githubToken() };
	});
	r.post("/api/w/:ws/grants", async (req) => {
		const { user, ws } = await member(req, "editor");
		const { airlock, connection, resource, label, holder, autoApprove, methods, policy, requestId } = await req.body();
		if (!holder || !["conversation", "module", "mission"].includes(holder.kind) || typeof holder.id !== "string") throw new HttpError(400, "holder must be {kind: conversation|module|mission, id, roles?}");
		if (holder.roles !== undefined && !(holder.kind === "mission" && Array.isArray(holder.roles) && holder.roles.every((r: unknown) => typeof r === "string"))) throw new HttpError(400, "roles: a list of role ids, for mission holders only");
		if (holder.kind === "mission" && !(await ws.missions.list()).some((p) => p.id === holder.id)) throw new HttpError(404, "No such mission");
		if (methods !== undefined && !(Array.isArray(methods) && methods.every((m: unknown) => typeof m === "string"))) throw new HttpError(400, "methods must be a list of names");
		return { grant: await ws.grant({ airlock, connection, resource: String(resource ?? ""), label, holder, autoApprove, methods, policy, by: user.displayName, requestId }) };
	});
	r.patch("/api/w/:ws/grants/:id", async (req) => {
		const { ws } = await member(req, "editor");
		const { autoApprove, methods, policy } = await req.body();
		await ws.updateGrant(req.params.id!, { autoApprove: autoApprove === undefined ? undefined : !!autoApprove, methods, policy });
		return { ok: true };
	});

	// ------------------------------------------------------------ connections (generic connectors)
	r.get("/api/connectors", (req) => {
		req.need();
		return { connectors: Object.entries(CONNECTOR_INFO).map(([id, c]) => ({ id, ...c })) };
	});
	r.get("/api/w/:ws/connections", async (req) => {
		const { ws } = await member(req);
		return { connections: await Promise.all((await ws.connections.list()).map((c) => ws.connections.describe(c))), proposals: await ws.connections.proposals() };
	});
	r.post("/api/w/:ws/connection-proposals/:id/accept", async (req) => {
		const { user, ws } = await member(req, "owner");
		return { connection: await ws.connections.describe(await ws.acceptProposal(req.params.id!, await req.body(), user.displayName)) };
	});
	r.post("/api/w/:ws/connection-proposals/:id/decline", async (req) => {
		const { user, ws } = await member(req, "owner");
		return { proposal: await ws.declineProposal(req.params.id!, user.displayName) };
	});
	r.get("/api/w/:ws/connections/:id", async (req) => {
		const { ws } = await member(req);
		return { connection: await ws.connections.describe(await ws.connections.require(req.params.id!)) };
	});
	r.post("/api/w/:ws/connections", async (req) => {
		const { user, ws } = await member(req, "owner");
		return { connection: await ws.connections.describe(await ws.connections.create(await req.body(), user.displayName)) };
	});
	r.patch("/api/w/:ws/connections/:id", async (req) => {
		const { ws } = await member(req, "owner");
		return { connection: await ws.connections.describe(await ws.connections.update(req.params.id!, await req.body())) };
	});
	r.post("/api/w/:ws/connections/:id/refresh", async (req) => {
		const { ws } = await member(req, "owner");
		return { connection: await ws.connections.describe(await ws.connections.refresh(req.params.id!)) };
	});
	/** Body: { method, mode: "ask" | "allow" | null }. Owners decide, per method, whether it asks first or runs without asking (null: the default). */
	r.put("/api/w/:ws/connections/:id/approval", async (req) => {
		const { user, ws } = await member(req, "owner");
		const { method, mode } = await req.body();
		if (typeof method !== "string" || !method) throw new HttpError(400, "method is required");
		await ws.setConnectionApproval(req.params.id!, method, mode === undefined ? null : mode, user.displayName);
		return { connection: await ws.connections.describe(await ws.connections.require(req.params.id!)) };
	});
	r.delete("/api/w/:ws/connections/:id", async (req) => {
		const { ws } = await member(req, "owner");
		await ws.removeConnection(req.params.id!);
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

	// ------------------------------------------------------------ module frame (sandboxed origin)
	r.get("/frame/:id", async (req) => {
		const claims = verify<{ g: string; u: string; n: string; r: Role }>(req.query.get("t") ?? undefined);
		if (!claims || claims.g !== req.params.id) throw new HttpError(403, "Frame token expired — reload the module");
		const g = modules.get(claims.g);
		if (!g) throw new HttpError(404, "No such module");
		const ws = await Workspace.get(g.workspaceId);
		const html = buildFrame(await ws.moduleFiles(g.id), { moduleId: g.id, user: { id: claims.u, name: claims.n, role: claims.r } });
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
