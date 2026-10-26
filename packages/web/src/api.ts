export type Role = "owner" | "editor" | "viewer";
export type User = { id: string; username: string; displayName: string };
export type Workspace = { id: string; name: string; ownerId: string; role: Role; settings: WorkspaceSettings };
export type WorkspaceSettings = { companyContext?: string; defaultModel?: ModelRef; toolMode?: "hybrid" | "codemode" };
export type ModelRef = { provider: string; modelId: string };
export type ModelInfo = { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; vision: boolean };
export type Gadget = { id: string; workspaceId: string; ownerId: string; name: string; icon: string; blueprintId: string | null; updatedAt: number; role: Role; workspaceName?: string; owner?: string; blueprint?: BlueprintIntro };
export type Suggestion = { k: string; t: string; d: string; p: string };
/** How a fresh chat beside a gadget greets the user; comes from the blueprint the gadget was made from. */
export type BlueprintIntro = { name: string; description: string; headline?: string; intro?: string; suggestions?: Suggestion[] };
export type Blueprint = { id: string; name: string; description: string; icon: string; authorId: string | null; author?: string; visibility: string; fileCount: number; mine: boolean };
export type GatekeeperInfo = { id: string; title: string; icon: string; description: string; resourceHint: string; setup?: string; methods: { name: string; description: string; effect: "read" | "write" }[] };
export type Holder = { kind: "conversation" | "gadget" | "project"; id: string; roles?: string[] };
export type Policy = "ask" | "auto" | "deny";
export type Grant = { id: string; gatekeeper: string; resource: string; label: string; holder: Holder; autoApprove: boolean; connection?: string; methods?: string[]; policy?: Record<string, Policy>; createdBy: string; createdAt: number };
export type AccessRequest = { id: string; gatekeeper: string; resource: string; reason: string; holder: Holder; connection?: string; methods?: string[]; status: "pending" | "granted" | "denied"; createdAt: number };
export type ConnectionAuth = { kind: "none" } | { kind: "bearer" } | { kind: "header"; name: string } | { kind: "basic" } | { kind: "query"; name: string };
export type ConnectionMethod = { name: string; description: string; effect: "read" | "write"; alwaysAsk: boolean; classifiedBy: "server" | "spec" | "owner" | "default"; params: Record<string, string> };
/** A connection an agent drafted (no secret) for an owner to review, add the key and connect. */
export type ConnectionProposal = {
	id: string;
	kind: "mcp" | "openapi" | "azure-devops";
	label: string;
	title?: string;
	url?: string;
	transport?: "http" | "sse";
	spec?: string;
	baseUrl?: string;
	params?: Record<string, string>;
	auth: ConnectionAuth;
	reason: string;
	setup?: string;
	proposedBy: { kind: "conversation"; id: string; name: string };
	status: "pending" | "accepted" | "declined";
	connection?: string;
	decidedBy?: string;
	createdAt: number;
};
/** A workspace connection (generic connector: MCP server or OpenAPI REST API), as the API shows it: no secret values. */
export type ConnectionInfo = {
	id: string;
	kind: "mcp" | "openapi" | "azure-devops";
	label: string;
	title: string;
	icon: string;
	source: "workspace" | "config";
	trust: "vetted" | "byo";
	url?: string;
	transport?: "http" | "sse" | "stdio";
	command?: string;
	spec?: string;
	baseUrl?: string;
	apiBase?: string;
	params?: Record<string, string>;
	account?: string;
	auth: ConnectionAuth;
	reads?: string[];
	methods: ConnectionMethod[];
	status: "ok" | "error" | "pending";
	error?: string;
	refreshedAt?: number;
	createdBy: string;
	createdAt: number;
	secretsSet: string[];
	secretsNeeded: string[];
};
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
	files: { files: Record<string, FileMeta> };
};
export type FileMeta = {
	id: string;
	name: string;
	mime: string;
	size: number;
	kind: string;
	createdAt: number;
	createdBy: string;
	source: "upload" | "agent" | "gadget" | "extract";
	parent?: string;
	chatId?: string;
	gadgets: string[];
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

/** Upload one file (raw body). Resolves with its metadata. */
export function uploadFile(ws: string, file: File, onProgress?: (fraction: number) => void): Promise<FileMeta> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", `/api/w/${ws}/files`);
		xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name || "pasted"));
		xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
		xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
		xhr.onload = () => {
			const body = (() => {
				try {
					return JSON.parse(xhr.responseText);
				} catch {
					return {};
				}
			})();
			if (xhr.status >= 200 && xhr.status < 300) resolve(body.file);
			else reject(new ApiError(xhr.status, body.error ?? xhr.statusText));
		};
		xhr.onerror = () => reject(new Error("Upload failed"));
		xhr.send(file);
	});
}

export const fileUrl = (ws: string, id: string, inline = false) => `/api/w/${ws}/files/${id}${inline ? "?inline" : ""}`;
export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

export const api = {
	get: <T = any>(p: string) => request<T>("GET", p),
	post: <T = any>(p: string, b: unknown = {}) => request<T>("POST", p, b),
	put: <T = any>(p: string, b: unknown) => request<T>("PUT", p, b),
	patch: <T = any>(p: string, b: unknown) => request<T>("PATCH", p, b),
	del: <T = any>(p: string) => request<T>("DELETE", p),
};

// ------------------------------------------------------------------ projects (agent teams)

export type ProjectStage = "kickoff" | "discovery" | "design" | "planning" | "build" | "iterate" | "done";
export type ProjectMeta = { id: string; name: string; goal: string; stage: ProjectStage; createdAt: number; createdBy: string; model: ModelRef; archived?: boolean };
export type AgentRecord = { key: string; name: string; role: string; conversationId: string; brief: string; model?: ModelRef; createdAt: number; removed?: boolean };
export type Question = { id: string; agent: string; text: string; at: number; blocking?: boolean; assumption?: string; answeredAt?: number; resolution?: "answered" | "dismissed"; resolvedBy?: string; note?: string };
/** Questions from before the flag existed are blocking. */
export const isBlocking = (q: Question) => q.blocking !== false;
export type Feedback = { id: string; text: string; by: string; at: number; head?: string; files?: string[]; declined?: { by: string; reason: string; at: number } };
export type Activity = { at: number; agent?: string; kind: "team" | "message" | "publish" | "question" | "stage" | "user" | "error"; text: string };
export type AttachmentRecord = { name: string; fileId: string; original: string; kind: string; mime: string; size: number; at: number; by: string };
export type ProjectState = { agents: Record<string, AgentRecord>; order: string[]; questions: Record<string, Question>; activity: Activity[]; attachments?: Record<string, AttachmentRecord>; feedback?: Record<string, Feedback>; feedbackSeq?: number; gates?: Partial<Record<GateName, DocGate>> };
export type AgentSummary = { busy: boolean; status: "idle" | "thinking" | "writing" | "tool" | "error"; activity?: string; tail: string; tokens: number; cost: number; queued: number; error?: string; updatedAt: number };

export type ItemType = "feature" | "pbi" | "task";
export type ItemStatus = "todo" | "doing" | "review" | "done" | "blocked";
export type BacklogItem = { id: string; type: ItemType; parent?: string; title: string; description?: string; acceptance?: string[]; status: ItemStatus; assignee?: string; deps: string[]; area?: string; estimate?: "S" | "M" | "L"; order: number; createdBy: string; updatedAt: number;
	feedback?: string; pending?: boolean; context?: string[];
	checks?: TaskCheck; approvedBy?: string; dod?: { by: string; at: number; items: { text: string; met: boolean; note?: string }[] };
	attempt?: number; briefed?: boolean; reviewer?: string; reviewRound?: number; reviewBriefed?: boolean;
	submitted?: { commit: string; summary: string; at: number; by: string; files: string[] }; merged?: string; nudges?: number;
	history?: { at: number; by: string; text: string }[];
};
export type BuildState = { paused?: boolean; startedAt?: number; finishedAt?: number; retro?: string; retroNotes?: boolean };
export type TaskCheck = { status: "running" | "passed" | "failed" | "skipped"; stage: "submit" | "merge"; commit: string; at: number; command?: string; output?: string; reason?: string; ms?: number };
export type GateName = "requirements" | "design";
export type DocGate = { status: "pending" | "approved" | "changes"; summary?: string; requestedBy?: string; requestedAt?: number; commit?: string; decidedBy?: string; decidedAt?: number; comment?: string };
export type PreviewStatus = "off" | "no-config" | "installing" | "starting" | "running" | "crashed" | "failed";
export type PreviewInfo = { status: PreviewStatus; port?: number; appPort?: number; host?: string; head?: string; error?: string; command?: string; startedAt?: number; readyAt?: number; logSeq: number; stoppedByUser?: boolean };
export type PreviewLogLine = { seq: number; at: number; text: string; stream: "out" | "err" | "pi-os" };
export type BacklogApproval = { status: "draft" | "pending" | "approved" | "changes"; summary?: string; requestedBy?: string; requestedAt?: number; decidedBy?: string; decidedAt?: number; comment?: string; revision?: number };
export type Backlog = { items: Record<string, BacklogItem>; seq: Record<ItemType, number>; approval: BacklogApproval; revision: number; build?: BuildState; pendingRequest?: { summary: string; requestedBy: string; requestedAt: number } };

// ---------------------------------------------------------------- workspace homepage

export type HomeChatActivity = {
	chatId: string;
	title: string;
	runs: number;
	messages: number;
	tools: { name: string; count: number }[];
	firstAt: number;
	lastAt: number;
	snippet?: string;
	failed?: boolean;
	/** A model-written line about it, when one was asked for and is still current. */
	summary?: string;
};
export type HomeProject = { id: string; name: string; stage: string; open: number; changes: number; lastAt?: number };
export type HomePayload = {
	since: number;
	now: number;
	firstVisit: boolean;
	away: {
		chats: HomeChatActivity[];
		gadgets: { id: string; name: string; icon: string; at: number }[];
		projects: HomeProject[];
		approvals: { pending: number; decided: number };
		files: number;
		audit: number;
		totals: { runs: number; messages: number; tools: number };
	};
	pickup: {
		lastChat?: { id: string; title: string; at: number };
		approvals: { id: string; summary: string; gatekeeper: string; at: number; requestedBy: string }[];
		questions: { projectId: string; project: string; agent: string; text: string; at: number }[];
	};
	projects: HomeProject[];
};
