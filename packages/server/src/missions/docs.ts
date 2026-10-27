import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";

/** Where a mission is in its lifecycle (see docs/design/agent-teams.md). */
export type MissionStage = "kickoff" | "discovery" | "design" | "planning" | "build" | "iterate" | "done";

export type MissionMeta = {
	id: string;
	name: string;
	goal: string;
	stage: MissionStage;
	createdAt: number;
	createdBy: string;
	/** Model new agents get unless the Lead picks another. */
	model: { provider: string; modelId: string };
	archived?: boolean;
};

/** The workspace's missions. */
export const MissionsDoc = defineDoc<{ missions: Record<string, MissionMeta> }>({
	kind: "outpost.missions",
	version: 1,
	scope: "session",
	initial: () => ({ missions: {} }),
	checkpointWhen: () => false,
});

export type AgentRecord = {
	/** Stable handle used in tools and URLs: "lead", "po", "worker-2". */
	key: string;
	name: string;
	role: string;
	conversationId: string;
	brief: string;
	model?: { provider: string; modelId: string };
	createdAt: number;
	removed?: boolean;
};

/** A file the user handed the team, kept outside git in the mission's attachments folder. */
export type AttachmentRecord = { name: string; fileId: string; original: string; kind: string; mime: string; size: number; at: number; by: string };

/**
 * A question an agent asked the user. Blocking (the default, and every question from before the flag
 * existed): the agent stops until it's answered, and nothing can be approved to build while it's open.
 * Non-blocking: the agent states the assumption it works with and carries on.
 */
export type Question = {
	id: string;
	agent: string;
	text: string;
	at: number;
	blocking?: boolean;
	/** Non-blocking questions: what the agent assumes meanwhile. */
	assumption?: string;
	answeredAt?: number;
	/** How it was closed: answered, or dismissed by the user (with an optional note). */
	resolution?: "answered" | "dismissed";
	resolvedBy?: string;
	note?: string;
};
export const isBlocking = (q: Question) => q.blocking !== false;
/** Open blocking questions: while any exist the mission isn't ready to build. */
export const openBlocking = (st: Pick<MissionState, "questions">) => Object.values(st.questions).filter((q) => !q.answeredAt && isBlocking(q));

/** The user's feedback on the running app, tied to the version of main they saw. Backlog items link to it. */
export type Feedback = { id: string; text: string; by: string; at: number; head?: string; files?: string[]; declined?: { by: string; reason: string; at: number } };
export type Activity = { at: number; agent?: string; kind: "team" | "message" | "publish" | "question" | "stage" | "user" | "error"; text: string };

/** The user's approval of a document stage (M2). Requested by the lead, decided on the doc's tab. */
export type GateName = "requirements" | "design";
export const GATE_DOCS: Record<GateName, string> = { requirements: "docs/requirements.md", design: "docs/design.md" };
export type DocGate = { status: "pending" | "approved" | "changes"; summary?: string; requestedBy?: string; requestedAt?: number; commit?: string; decidedBy?: string; decidedAt?: number; comment?: string };

export type MissionState = {
	agents: Record<string, AgentRecord>;
	/** Display order of agents (tiles). */
	order: string[];
	questions: Record<string, Question>;
	/** Newest last, bounded. */
	activity: Activity[];
	/** By stored file name. Absent in missions created before attachments moved out of git. */
	attachments?: Record<string, AttachmentRecord>;
	/** FB-1, FB-2, … */
	feedback?: Record<string, Feedback>;
	feedbackSeq?: number;
	/** Document gates. Present (possibly empty) on missions created with gates; older missions have none and aren't held to them. */
	gates?: Partial<Record<GateName, DocGate>>;
};

/** One document per mission: its team, open questions for the user, and activity feed. */
export const MissionDoc = defineDocFamily<MissionState, null>({
	kind: "outpost.mission",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ agents: {}, order: [], questions: {}, activity: [], attachments: {} }),
	checkpointWhen: (_v: unknown, _ops: unknown, info: { deltasSinceBase: number }) => info.deltasSinceBase >= 40,
} as any);

export const ACTIVITY_LIMIT = 300;
