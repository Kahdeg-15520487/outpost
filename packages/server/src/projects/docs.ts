import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";

/** Where a project is in its lifecycle (see docs/design/agent-teams.md). */
export type ProjectStage = "kickoff" | "discovery" | "design" | "planning" | "build" | "iterate" | "done";

export type ProjectMeta = {
	id: string;
	name: string;
	goal: string;
	stage: ProjectStage;
	createdAt: number;
	createdBy: string;
	/** Model new agents get unless the Lead picks another. */
	model: { provider: string; modelId: string };
	archived?: boolean;
};

/** The workspace's projects. */
export const ProjectsDoc = defineDoc<{ projects: Record<string, ProjectMeta> }>({
	kind: "os.projects",
	version: 1,
	scope: "session",
	initial: () => ({ projects: {} }),
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

/** A file the user handed the team, kept outside git in the project's attachments folder. */
export type AttachmentRecord = { name: string; fileId: string; original: string; kind: string; mime: string; size: number; at: number; by: string };

export type Question = { id: string; agent: string; text: string; at: number; answeredAt?: number };
export type Activity = { at: number; agent?: string; kind: "team" | "message" | "publish" | "question" | "stage" | "user" | "error"; text: string };

export type ProjectState = {
	agents: Record<string, AgentRecord>;
	/** Display order of agents (tiles). */
	order: string[];
	questions: Record<string, Question>;
	/** Newest last, bounded. */
	activity: Activity[];
	/** By stored file name. Absent in projects created before attachments moved out of git. */
	attachments?: Record<string, AttachmentRecord>;
};

/** One document per project: its team, open questions for the user, and activity feed. */
export const ProjectDoc = defineDocFamily<ProjectState, null>({
	kind: "os.project",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ agents: {}, order: [], questions: {}, activity: [], attachments: {} }),
	checkpointWhen: (_v: unknown, _ops: unknown, info: { deltasSinceBase: number }) => info.deltasSinceBase >= 40,
} as any);

export const ACTIVITY_LIMIT = 300;
