import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { Connection, ConnectionProposal } from "../gatekeepers/connectors/types.ts";

/**
 * Workspace state lives in pi-durable documents inside the workspace's Harness, so every change is
 * committed atomically with the agent work that caused it, survives restarts, and can be watched live.
 */
const latest = { checkpointWhen: () => false } as const;
// Large documents that churn: write a full base every so often to bound replay.
const every = (n: number) => ({ checkpointWhen: (_v: unknown, _ops: unknown, info: { deltasSinceBase: number }) => info.deltasSinceBase >= n }) as any;

export type ChatMeta = { id: string; title: string; createdAt: number; createdBy: string; updatedAt: number; archived?: boolean };
export const ChatsDoc = defineDoc<{ chats: Record<string, ChatMeta> }>({
	kind: "os.chats",
	version: 1,
	scope: "session",
	initial: () => ({ chats: {} }),
	...latest,
});

/** Gadget source: one document per gadget. */
export type GadgetSource = { files: Record<string, string>; revision: number };
export const GadgetSourceDoc = defineDocFamily<GadgetSource, null>({
	kind: "os.gadget.source",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ files: {}, revision: 0 }),
	...every(20),
});

/** Gadget server storage (the KV its `ctx.storage` sees). Each RPC call commits its writes at once. */
export const GadgetStateDoc = defineDocFamily<{ kv: Record<string, any> }, null>({
	kind: "os.gadget.state",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ kv: {} }),
	...every(50),
});

/** Gadget console output and errors, newest last, bounded. */
export type LogLine = { at: number; level: "log" | "warn" | "error" | "call"; text: string };
export const GadgetLogsDoc = defineDocFamily<{ lines: LogLine[] }, null>({
	kind: "os.gadget.logs",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ lines: [] }),
	...every(50),
});

// ---------------------------------------------------------------- gatekeepers

/** Who holds a grant: a chat, a gadget, or a project team (optionally only some roles: lead, worker, …). */
export type Holder = { kind: "conversation" | "gadget" | "project"; id: string; roles?: string[] };
export type Grant = {
	id: string;
	gatekeeper: string;
	resource: string;
	label: string;
	holder: Holder;
	/** Side-effecting calls run immediately instead of queuing for approval (unless `policy` says otherwise for a method). */
	autoApprove: boolean;
	/** A capability on a workspace connection (MCP server, REST API): its id. `gatekeeper` is then the connector kind. */
	connection?: string;
	/** Only these methods; absent = all of them. */
	methods?: string[];
	/** Per write method: ask (queue for approval), auto (run), deny (refuse). Absent methods follow `autoApprove`. */
	policy?: Record<string, "ask" | "auto" | "deny">;
	createdBy: string;
	createdAt: number;
};
export type AccessRequest = {
	id: string;
	gatekeeper: string;
	resource: string;
	reason: string;
	holder: Holder;
	/** A request for a workspace connection. */
	connection?: string;
	/** The methods the requester says it needs. */
	methods?: string[];
	status: "pending" | "granted" | "denied";
	createdAt: number;
};
export const GrantsDoc = defineDoc<{ grants: Record<string, Grant>; requests: Record<string, AccessRequest> }>({
	kind: "os.grants",
	version: 1,
	scope: "session",
	initial: () => ({ grants: {}, requests: {} }),
	...latest,
});

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
export const ApprovalsDoc = defineDoc<{ actions: Record<string, ApprovalAction> }>({
	kind: "os.approvals",
	version: 1,
	scope: "session",
	initial: () => ({ actions: {} }),
	...every(50),
});

/** Third-party services added to this workspace (generic connectors: MCP servers, OpenAPI REST APIs). Secrets are stored apart, encrypted. */
export const ConnectionsDoc = defineDoc<{ connections: Record<string, Connection>; proposals?: Record<string, ConnectionProposal> }>({
	kind: "os.connections",
	version: 1,
	scope: "session",
	initial: () => ({ connections: {} }),
	...every(20),
});

export type AuditLine = { at: number; grantId: string; gatekeeper: string; method: string; by: string; outcome: "ok" | "error" | "queued" | "simulated"; detail?: string };
export const AuditDoc = defineDoc<{ lines: AuditLine[] }>({
	kind: "os.audit",
	version: 1,
	scope: "session",
	initial: () => ({ lines: [] }),
	...every(50),
});

/** Built-in `mailbox` gatekeeper: a local outbox, so approvals can be tried without any external account. */
export type Mail = { id: string; to: string; subject: string; body: string; sentAt: number };
// ---------------------------------------------------------------- files

/**
 * Workspace files. Bytes live content-addressed on disk next to the workspace database; this
 * durable document is the index (so uploads, agent outputs and gadget outputs are committed and
 * watched like everything else).
 */
export type FileMeta = {
	id: string;
	name: string;
	mime: string;
	size: number;
	sha256: string;
	/** Sniffed from the bytes: pdf, zip, docx, png, text, json, sqlite, binary, … */
	kind: string;
	createdAt: number;
	createdBy: string;
	source: "upload" | "agent" | "gadget" | "extract";
	/** The file this one was extracted or derived from. */
	parent?: string;
	/** Chat it was attached in, if any. */
	chatId?: string;
	/** Gadgets allowed to read it through ctx.files (a capability, like a grant). */
	gadgets: string[];
};
export const FilesDoc = defineDoc<{ files: Record<string, FileMeta> }>({
	kind: "os.files",
	version: 1,
	scope: "session",
	initial: () => ({ files: {} }),
	...every(50),
});
export const MailboxDoc = defineDoc<{ sent: Mail[] }>({
	kind: "os.mailbox",
	version: 1,
	scope: "session",
	initial: () => ({ sent: [] }),
	...latest,
});

// ---------------------------------------------------------------- the workspace homepage

/**
 * One finished agent run in a chat. Transcript entries carry no wall-clock time, so "what happened
 * while I was away" can't be read back out of them: the run is recorded when it ends instead.
 */
export type RunRecord = {
	id: string;
	chatId: string;
	title: string;
	/** When the run started and when it settled (the field the homepage filters on). */
	at: number;
	endedAt: number;
	/** Assistant messages produced by the run, and how many calls it made of each tool. */
	messages: number;
	tools: Record<string, number>;
	/** The run's last assistant text, clipped: shown as-is, and what summaries are written from. */
	snippet?: string;
	/** Set when the run ended badly (tool task faulted, retries exhausted). */
	failed?: string;
};

/** A model-written line about what happened in a chat, cached until newer runs appear. */
export type ChatSummary = { upTo: number; text: string; at: number; model: string };

/** Newest last, bounded. `summaries` is keyed by chat id. */
export const ActivityDoc = defineDoc<{ runs: RunRecord[]; summaries: Record<string, ChatSummary> }>({
	kind: "os.activity",
	version: 1,
	scope: "session",
	initial: () => ({ runs: [], summaries: {} }),
	...every(40),
});
export const ACTIVITY_RUNS = 300;
