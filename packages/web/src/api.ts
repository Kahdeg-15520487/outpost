export type Role = "owner" | "editor" | "viewer";
export type User = { id: string; username: string; displayName: string };
export type Workspace = { id: string; name: string; ownerId: string; role: Role; settings: WorkspaceSettings };
export type WorkspaceSettings = { companyContext?: string; defaultModel?: ModelRef; toolMode?: "hybrid" | "codemode" };
export type ModelRef = { provider: string; modelId: string };
export type ModelInfo = { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; vision: boolean };
export type Gadget = { id: string; workspaceId: string; ownerId: string; name: string; icon: string; blueprintId: string | null; updatedAt: number; role: Role; workspaceName?: string; owner?: string };
export type Blueprint = { id: string; name: string; description: string; icon: string; authorId: string | null; author?: string; visibility: string; fileCount: number; mine: boolean };
export type GatekeeperInfo = { id: string; title: string; icon: string; description: string; resourceHint: string; setup?: string; methods: { name: string; description: string; effect: "read" | "write" }[] };
export type Holder = { kind: "conversation" | "gadget"; id: string };
export type Grant = { id: string; gatekeeper: string; resource: string; label: string; holder: Holder; autoApprove: boolean; createdBy: string; createdAt: number };
export type AccessRequest = { id: string; gatekeeper: string; resource: string; reason: string; holder: Holder; status: "pending" | "granted" | "denied"; createdAt: number };
export type ApprovalAction = {
	id: string;
	grantId: string;
	gatekeeper: string;
	resource: string;
	method: string;
	args: any;
	summary: string;
	status: "pending" | "approved" | "rejected" | "failed";
	simulated: any;
	result?: any;
	error?: string;
	requestedBy: Holder & { name: string };
	createdAt: number;
	decidedAt?: number;
	decidedBy?: string;
};
export type ChatMeta = { id: string; title: string; createdAt: number; createdBy: string; updatedAt: number; archived?: boolean };
export type AuditLine = { at: number; grantId: string; gatekeeper: string; method: string; by: string; outcome: string; detail?: string };
export type WorkspaceDocs = {
	chats: { chats: Record<string, ChatMeta> };
	grants: { grants: Record<string, Grant>; requests: Record<string, AccessRequest> };
	approvals: { actions: Record<string, ApprovalAction> };
	audit: { lines: AuditLine[] };
	mailbox: { sent: { id: string; to: string; subject: string; body: string; sentAt: number }[] };
};
export type LogLine = { at: number; level: "log" | "warn" | "error" | "call"; text: string };

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		credentials: "same-origin",
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText);
	return json as T;
}

export const api = {
	get: <T = any>(p: string) => request<T>("GET", p),
	post: <T = any>(p: string, b: unknown = {}) => request<T>("POST", p, b),
	put: <T = any>(p: string, b: unknown) => request<T>("PUT", p, b),
	patch: <T = any>(p: string, b: unknown) => request<T>("PATCH", p, b),
	del: <T = any>(p: string) => request<T>("DELETE", p),
};
