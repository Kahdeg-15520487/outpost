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
export type Question = { id: string; agent: string; text: string; at: number; answeredAt?: number };
export type Activity = { at: number; agent?: string; kind: "team" | "message" | "publish" | "question" | "stage" | "user" | "error"; text: string };
export type AttachmentRecord = { name: string; fileId: string; original: string; kind: string; mime: string; size: number; at: number; by: string };
export type ProjectState = { agents: Record<string, AgentRecord>; order: string[]; questions: Record<string, Question>; activity: Activity[]; attachments?: Record<string, AttachmentRecord> };
export type AgentSummary = { busy: boolean; status: "idle" | "thinking" | "writing" | "tool" | "error"; activity?: string; tail: string; tokens: number; cost: number; queued: number; error?: string; updatedAt: number };
