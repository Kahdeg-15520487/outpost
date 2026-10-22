import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";

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

export type Holder = { kind: "conversation" | "gadget"; id: string };
export type Grant = {
	id: string;
	gatekeeper: string;
	resource: string;
	label: string;
	holder: Holder;
	/** Side-effecting calls run immediately instead of queuing for approval. */
	autoApprove: boolean;
	createdBy: string;
	createdAt: number;
};
export type AccessRequest = {
	id: string;
	gatekeeper: string;
	resource: string;
	reason: string;
	holder: Holder;
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
export const MailboxDoc = defineDoc<{ sent: Mail[] }>({
	kind: "os.mailbox",
	version: 1,
	scope: "session",
	initial: () => ({ sent: [] }),
	...latest,
});
