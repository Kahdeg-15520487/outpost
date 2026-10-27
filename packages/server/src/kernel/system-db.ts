import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { config } from "../config.ts";

/**
 * The system database holds what crosses workspace boundaries: users, sessions, workspace
 * membership, the module index with its ACLs and share links, and blueprints. Everything that
 * belongs to one workspace (chats, agent runs, module code and state, grants, approvals) lives
 * in that workspace's pi-durable Harness.
 */
export type Role = "owner" | "editor" | "viewer";
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export type User = { id: string; username: string; displayName: string };
export type WorkspaceRow = { id: string; name: string; ownerId: string; createdAt: number; settings: WorkspaceSettings };
export type WorkspaceSettings = {
	companyContext?: string;
	defaultModel?: { provider: string; modelId: string };
	toolMode?: "hybrid" | "codemode";
};
export type ModuleRow = {
	id: string;
	workspaceId: string;
	ownerId: string;
	name: string;
	icon: string;
	blueprintId: string | null;
	createdAt: number;
	updatedAt: number;
};
export type BlueprintRow = {
	id: string;
	name: string;
	description: string;
	icon: string;
	authorId: string | null;
	visibility: "public" | "private";
	files: Record<string, string>;
	createdAt: number;
	builtin?: boolean;
	/** How a fresh chat next to a module made from this blueprint greets the user. */
	intro?: BlueprintIntro;
};

export type BlueprintSuggestion = { k: string; t: string; d: string; p: string };
export type BlueprintIntro = { headline?: string; intro?: string; suggestions?: BlueprintSuggestion[] };

const db = new DatabaseSync(config.systemDb);
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gadgets'").get()) {
	db.close();
	throw new Error("This data directory needs the offline Outpost migration. See docs/upgrading-to-outpost.md. Do not start the old and new servers together.");
}
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS workspace_members (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (workspace_id, user_id));
CREATE TABLE IF NOT EXISTS modules (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '◆', blueprint_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS module_shares (module_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (module_id, user_id));
CREATE TABLE IF NOT EXISTS share_links (token TEXT PRIMARY KEY, module_id TEXT NOT NULL, role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blueprints (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '◆', author_id TEXT, visibility TEXT NOT NULL, files TEXT NOT NULL, created_at INTEGER NOT NULL);
`);
// Added after the first release; existing databases get the columns on startup.
if (!(db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "prefs")) db.exec("ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}'");
if (!(db.prepare("PRAGMA table_info(blueprints)").all() as { name: string }[]).some((c) => c.name === "intro")) db.exec("ALTER TABLE blueprints ADD COLUMN intro TEXT NOT NULL DEFAULT '{}'");

const secret = config.secret;

export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

// ---------------------------------------------------------------- users & sessions

function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
	return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}
function checkPassword(password: string, stored: string): boolean {
	const [salt, hash] = stored.split(":");
	const candidate = scryptSync(password, salt!, 32);
	return timingSafeEqual(candidate, Buffer.from(hash!, "hex"));
}

const toUser = (row: any): User => ({ id: row.id, username: row.username, displayName: row.display_name });

export const users = {
	create(username: string, password: string, displayName?: string): User {
		if (!/^[a-z0-9_.-]{2,32}$/i.test(username)) throw new HttpError(400, "Username: 2-32 chars of letters, digits, _ . -");
		if (password.length < 4) throw new HttpError(400, "Password must be at least 4 characters");
		if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw new HttpError(409, "Username taken");
		const user = { id: newId("u"), username, displayName: displayName?.trim() || username };
		db.prepare("INSERT INTO users (id, username, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(user.id, username, user.displayName, hashPassword(password), Date.now());
		return user;
	},
	login(username: string, password: string): User {
		const row: any = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
		if (!row || !checkPassword(password, row.pw_hash)) throw new HttpError(401, "Invalid username or password");
		return toUser(row);
	},
	get(id: string): User | undefined {
		const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
		return row ? toUser(row) : undefined;
	},
	byUsername(username: string): User | undefined {
		const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
		return row ? toUser(row) : undefined;
	},
	count(): number {
		return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n;
	},
	prefs(id: string): UserPrefs {
		const row: any = db.prepare("SELECT prefs FROM users WHERE id = ?").get(id);
		return row ? JSON.parse(row.prefs || "{}") : {};
	},
	setPrefs(id: string, patch: Partial<UserPrefs>): UserPrefs {
		const next = { ...users.prefs(id), ...patch };
		for (const k of Object.keys(next) as (keyof UserPrefs)[]) if (next[k] === undefined) delete next[k];
		db.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify(next), id);
		return next;
	},
};

/** Per-user preferences. */
export type UserPrefs = {
	/**
	 * Which models the picker shows, per provider: provider id → model ids. A provider that
	 * isn't listed shows all its models (so newly configured providers aren't invisible).
	 */
	modelPicker?: Record<string, string[]>;
	/** Workspace id → when this user last opened its homepage, which is what "while you were away" measures from. */
	seen?: Record<string, number>;
};

export const sessions = {
	create(userId: string): string {
		const token = randomBytes(24).toString("base64url");
		db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(token, userId, Date.now() + 30 * 86400_000);
		return token;
	},
	user(token: string | undefined): User | undefined {
		if (!token) return undefined;
		const row: any = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?").get(token);
		if (!row || row.expires_at < Date.now()) return undefined;
		return users.get(row.user_id);
	},
	delete(token: string) {
		db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
	},
};

// ---------------------------------------------------------------- workspaces

const toWorkspace = (row: any): WorkspaceRow => ({
	id: row.id,
	name: row.name,
	ownerId: row.owner_id,
	createdAt: row.created_at,
	settings: JSON.parse(row.settings),
});

export const workspaces = {
	create(name: string, ownerId: string): WorkspaceRow {
		const ws = { id: newId("w"), name, ownerId, createdAt: Date.now(), settings: {} };
		db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, '{}')").run(ws.id, name, ownerId, ws.createdAt);
		db.prepare("INSERT INTO workspace_members VALUES (?, ?, 'owner')").run(ws.id, ownerId);
		return ws;
	},
	get(id: string): WorkspaceRow | undefined {
		const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
		return row ? toWorkspace(row) : undefined;
	},
	allIds(): string[] {
		return db.prepare("SELECT id FROM workspaces").all().map((r: any) => r.id);
	},
	forUser(userId: string): (WorkspaceRow & { role: Role })[] {
		return db
			.prepare("SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at")
			.all(userId)
			.map((row: any) => ({ ...toWorkspace(row), role: row.role }));
	},
	role(workspaceId: string, userId: string): Role | undefined {
		return (db.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as any)?.role;
	},
	members(workspaceId: string) {
		return db
			.prepare("SELECT u.id, u.username, u.display_name, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?")
			.all(workspaceId)
			.map((r: any) => ({ id: r.id, username: r.username, displayName: r.display_name, role: r.role as Role }));
	},
	setMember(workspaceId: string, userId: string, role: Role | null) {
		if (role === null) db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role != 'owner'").run(workspaceId, userId);
		else db.prepare("INSERT INTO workspace_members VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role").run(workspaceId, userId, role);
	},
	update(id: string, patch: { name?: string; settings?: WorkspaceSettings }) {
		const current = workspaces.get(id);
		if (!current) return;
		const settings = { ...current.settings, ...patch.settings };
		db.prepare("UPDATE workspaces SET name = ?, settings = ? WHERE id = ?").run(patch.name ?? current.name, JSON.stringify(settings), id);
	},
};

// ---------------------------------------------------------------- modules index, ACL, links

const toModule = (row: any): ModuleRow => ({
	id: row.id,
	workspaceId: row.workspace_id,
	ownerId: row.owner_id,
	name: row.name,
	icon: row.icon,
	blueprintId: row.blueprint_id,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
});

export const modules = {
	create(workspaceId: string, ownerId: string, name: string, icon: string, blueprintId: string | null): ModuleRow {
		const now = Date.now();
		const row = { id: newId("mod"), workspaceId, ownerId, name, icon, blueprintId, createdAt: now, updatedAt: now };
		db.prepare("INSERT INTO modules VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, workspaceId, ownerId, name, icon, blueprintId, now, now);
		return row;
	},
	get(id: string): ModuleRow | undefined {
		const row = db.prepare("SELECT * FROM modules WHERE id = ?").get(id);
		return row ? toModule(row) : undefined;
	},
	inWorkspace(workspaceId: string): ModuleRow[] {
		return db.prepare("SELECT * FROM modules WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId).map(toModule);
	},
	sharedWith(userId: string): (ModuleRow & { role: Role })[] {
		return db
			.prepare("SELECT g.*, s.role FROM modules g JOIN module_shares s ON s.module_id = g.id WHERE s.user_id = ? ORDER BY g.updated_at DESC")
			.all(userId)
			.map((r: any) => ({ ...toModule(r), role: r.role }));
	},
	touch(id: string, patch: { name?: string; icon?: string } = {}) {
		const g = modules.get(id);
		if (!g) return;
		db.prepare("UPDATE modules SET name = ?, icon = ?, updated_at = ? WHERE id = ?").run(patch.name ?? g.name, patch.icon ?? g.icon, Date.now(), id);
	},
	delete(id: string) {
		db.prepare("DELETE FROM modules WHERE id = ?").run(id);
		db.prepare("DELETE FROM module_shares WHERE module_id = ?").run(id);
		db.prepare("DELETE FROM share_links WHERE module_id = ?").run(id);
	},
	/** Effective role: workspace membership first, then a direct share. */
	role(module: ModuleRow, userId: string): Role | undefined {
		const wsRole = workspaces.role(module.workspaceId, userId);
		const share = (db.prepare("SELECT role FROM module_shares WHERE module_id = ? AND user_id = ?").get(module.id, userId) as any)?.role as Role | undefined;
		if (!wsRole) return share;
		if (!share) return wsRole;
		return ROLE_RANK[wsRole] >= ROLE_RANK[share] ? wsRole : share;
	},
	shares(moduleId: string) {
		return db
			.prepare("SELECT u.id, u.username, u.display_name, s.role FROM module_shares s JOIN users u ON u.id = s.user_id WHERE s.module_id = ?")
			.all(moduleId)
			.map((r: any) => ({ id: r.id, username: r.username, displayName: r.display_name, role: r.role as Role }));
	},
	share(moduleId: string, userId: string, role: Role | null) {
		if (role === null) db.prepare("DELETE FROM module_shares WHERE module_id = ? AND user_id = ?").run(moduleId, userId);
		else db.prepare("INSERT INTO module_shares VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role").run(moduleId, userId, role);
	},
	createLink(moduleId: string, role: Role, createdBy: string): string {
		const token = randomBytes(12).toString("base64url");
		db.prepare("INSERT INTO share_links VALUES (?, ?, ?, ?, ?)").run(token, moduleId, role, createdBy, Date.now());
		return token;
	},
	links(moduleId: string) {
		return db.prepare("SELECT token, role, created_at FROM share_links WHERE module_id = ?").all(moduleId) as { token: string; role: Role; created_at: number }[];
	},
	link(token: string): { moduleId: string; role: Role } | undefined {
		const r: any = db.prepare("SELECT module_id, role FROM share_links WHERE token = ?").get(token);
		return r ? { moduleId: r.module_id, role: r.role } : undefined;
	},
	deleteLink(token: string) {
		db.prepare("DELETE FROM share_links WHERE token = ?").run(token);
	},
};

// ---------------------------------------------------------------- blueprints

const toBlueprint = (row: any): BlueprintRow => ({
	id: row.id,
	name: row.name,
	description: row.description,
	icon: row.icon,
	authorId: row.author_id,
	visibility: row.visibility,
	files: JSON.parse(row.files),
	createdAt: row.created_at,
	intro: JSON.parse(row.intro || "{}"),
});

export const blueprints = {
	upsert(bp: BlueprintRow) {
		db.prepare(
			"INSERT INTO blueprints (id, name, description, icon, author_id, visibility, files, created_at, intro) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET name=excluded.name, description=excluded.description, icon=excluded.icon, visibility=excluded.visibility, files=excluded.files, intro=excluded.intro",
		).run(bp.id, bp.name, bp.description, bp.icon, bp.authorId, bp.visibility, JSON.stringify(bp.files), bp.createdAt, JSON.stringify(bp.intro ?? {}));
	},
	get(id: string): BlueprintRow | undefined {
		const row = db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id);
		return row ? toBlueprint(row) : undefined;
	},
	visibleTo(userId: string): BlueprintRow[] {
		return db
			.prepare("SELECT * FROM blueprints WHERE visibility = 'public' OR author_id = ? ORDER BY author_id IS NOT NULL, created_at")
			.all(userId)
			.map(toBlueprint);
	},
	delete(id: string) {
		db.prepare("DELETE FROM blueprints WHERE id = ?").run(id);
	},
};

// ---------------------------------------------------------------- signed tokens (module frames)

export function sign(payload: object, ttlMs: number): string {
	const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString("base64url");
	const mac = createHmac("sha256", secret).update(body).digest("base64url");
	return `${body}.${mac}`;
}
export function verify<T>(token: string | undefined): T | undefined {
	if (!token) return undefined;
	const [body, mac] = token.split(".");
	if (!body || !mac) return undefined;
	const expected = createHmac("sha256", secret).update(body).digest("base64url");
	if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return undefined;
	const payload = JSON.parse(Buffer.from(body, "base64url").toString());
	return payload.exp > Date.now() ? payload : undefined;
}

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
