import { defineDocFamily } from "@earendil-works/pi-durable";

/**
 * A project's backlog: features → product backlog items (PBIs) → tasks. pi-os is the source of
 * truth (structured, live, approvable); docs/backlog.md in the repo is a snapshot rendered from it.
 */
export type ItemType = "feature" | "pbi" | "task";
export type ItemStatus = "todo" | "doing" | "review" | "done" | "blocked";
export type Estimate = "S" | "M" | "L";

export type BacklogItem = {
	/** F1, P3, T12 — stable, never reused. */
	id: string;
	type: ItemType;
	/** A PBI's feature, a task's PBI. */
	parent?: string;
	title: string;
	description?: string;
	/** PBIs: acceptance criteria. */
	acceptance?: string[];
	status: ItemStatus;
	/** Agent key working on it. */
	assignee?: string;
	/** Items that must be done first. */
	deps: string[];
	/** Part of app/ it touches, so parallel tasks don't collide. */
	area?: string;
	estimate?: Estimate;
	order: number;
	createdBy: string;
	updatedAt: number;
	// ---- build (tasks; written by pi-os's scheduler, see build.ts)
	/** Times the task has been handed to a developer. */
	attempt?: number;
	/** The assignee has been sent this attempt's brief (re-sent after a crash if not). */
	briefed?: boolean;
	/** Agent reviewing the submitted work. */
	reviewer?: string;
	/** Review rounds so far; the reviewer has been sent this round's brief when reviewBriefed. */
	reviewRound?: number;
	reviewBriefed?: boolean;
	/** What the developer submitted with task_done: the commit that gets reviewed and merged. */
	submitted?: { commit: string; summary: string; at: number; by: string; files: string[] };
	/** The merge commit on main once done. */
	merged?: string;
	/** Reminders sent to the agent holding it while it sat idle. */
	nudges?: number;
	/** What happened to it, oldest first (bounded). */
	history?: { at: number; by: string; text: string }[];
};

export type BuildState = {
	/** No new assignments while paused; work in progress continues. */
	paused?: boolean;
	startedAt?: number;
	finishedAt?: number;
};

export type Approval = {
	status: "draft" | "pending" | "approved" | "changes";
	/** What the requester said when asking for approval. */
	summary?: string;
	requestedBy?: string;
	requestedAt?: number;
	/** The user's decision. */
	decidedBy?: string;
	decidedAt?: number;
	comment?: string;
	/** Backlog revision that was approved. */
	revision?: number;
};

export type Backlog = {
	items: Record<string, BacklogItem>;
	seq: Record<ItemType, number>;
	approval: Approval;
	/** Bumped on every change. */
	revision: number;
	/** The build (after approval): see build.ts. */
	build?: BuildState;
};

export const emptyBacklog = (): Backlog => ({ items: {}, seq: { feature: 0, pbi: 0, task: 0 }, approval: { status: "draft" }, revision: 0 });

export const BacklogDoc = defineDocFamily<Backlog, null>({
	kind: "os.project.backlog",
	version: 1,
	scope: "session",
	family: true,
	initial: emptyBacklog,
	checkpointWhen: (_v: unknown, _ops: unknown, info: { deltasSinceBase: number }) => info.deltasSinceBase >= 40,
} as any);

export const PREFIX: Record<ItemType, string> = { feature: "F", pbi: "P", task: "T" };
export const STATUSES: ItemStatus[] = ["todo", "doing", "review", "done", "blocked"];
export const STATUS_LABEL: Record<ItemStatus, string> = { todo: "To do", doing: "In progress", review: "Review", done: "Done", blocked: "Blocked" };
export const PARENT_TYPE: Record<ItemType, ItemType | undefined> = { feature: undefined, pbi: "feature", task: "pbi" };

export const byOrder = (a: BacklogItem, b: BacklogItem) => a.order - b.order || a.id.localeCompare(b.id, undefined, { numeric: true });

const HISTORY_LIMIT = 40;
export function pushHistory(item: BacklogItem, by: string, text: string) {
	item.history ??= [];
	item.history.push({ at: Date.now(), by, text });
	if (item.history.length > HISTORY_LIMIT) item.history.splice(0, item.history.length - HISTORY_LIMIT);
}

/** A PBI's or feature's status follows its children once it has any: done when all are, in progress when any started. */
export function rollUp(b: Backlog): boolean {
	let changed = false;
	const derive = (kids: BacklogItem[]): ItemStatus | undefined => {
		if (!kids.length) return undefined;
		if (kids.every((k) => k.status === "done")) return "done";
		if (kids.some((k) => k.status === "blocked")) return "blocked";
		if (kids.some((k) => k.status !== "todo")) return kids.every((k) => k.status === "done" || k.status === "review") ? "review" : "doing";
		return "todo";
	};
	for (const type of ["pbi", "feature"] as const) {
		for (const parent of Object.values(b.items).filter((i) => i.type === type)) {
			const s = derive(Object.values(b.items).filter((i) => i.parent === parent.id));
			if (s && s !== parent.status) {
				parent.status = s;
				parent.updatedAt = Date.now();
				changed = true;
			}
		}
	}
	return changed;
}

/** Every dependency is done (a dependency on a PBI or feature waits for all of it). */
export const depsDone = (b: Backlog, item: BacklogItem) => item.deps.every((d) => !b.items[d] || b.items[d]!.status === "done");
export const childrenOf = (b: Backlog, id: string | undefined, type: ItemType) =>
	Object.values(b.items)
		.filter((i) => i.type === type && (id === undefined ? !i.parent || !b.items[i.parent] : i.parent === id))
		.sort(byOrder);

/** docs/backlog.md: a readable snapshot for the repo. */
export function renderBacklog(b: Backlog, projectName: string): string {
	const lines: string[] = [`# Backlog — ${projectName}`, "", `> Generated by pi-os from the live backlog (revision ${b.revision}). Don't edit this file; it is overwritten.`, ""];
	const a = b.approval;
	lines.push(`**Approval:** ${a.status === "approved" ? `approved by ${a.decidedBy ?? "the user"}${a.revision !== undefined ? ` (revision ${a.revision})` : ""}` : a.status === "pending" ? "waiting for the user" : a.status === "changes" ? `changes requested: ${a.comment ?? ""}` : "draft"}`, "");
	const counts = Object.values(b.items).filter((i) => i.type === "task");
	if (counts.length) lines.push(`**Tasks:** ${STATUSES.map((s) => `${STATUS_LABEL[s]} ${counts.filter((t) => t.status === s).length}`).join(" · ")}`, "");
	const item = (i: BacklogItem) => {
		const meta = [i.estimate, i.area && `area: ${i.area}`, i.deps.length && `after ${i.deps.join(", ")}`, i.assignee && `@${i.assignee}`].filter(Boolean).join(" · ");
		return `${i.id} ${i.title} — ${STATUS_LABEL[i.status]}${meta ? ` (${meta})` : ""}`;
	};
	const featureless = { id: "", title: "No feature" } as BacklogItem;
	const features = [...childrenOf(b, undefined, "feature"), ...(childrenOf(b, undefined, "pbi").length ? [featureless] : [])];
	for (const f of features) {
		lines.push(f.id ? `## ${f.id} ${f.title}` : "## Unassigned PBIs", "");
		if (f.description) lines.push(f.description.trim(), "");
		for (const p of f.id ? childrenOf(b, f.id, "pbi") : childrenOf(b, undefined, "pbi")) {
			lines.push(`### ${item(p)}`, "");
			if (p.description) lines.push(p.description.trim(), "");
			if (p.acceptance?.length) lines.push("Acceptance criteria:", ...p.acceptance.map((c) => `- [${p.status === "done" ? "x" : " "}] ${c}`), "");
			const tasks = childrenOf(b, p.id, "task");
			if (tasks.length) lines.push(...tasks.map((t) => `- [${t.status === "done" ? "x" : " "}] ${item(t)}`), "");
		}
	}
	const orphans = childrenOf(b, undefined, "task");
	if (orphans.length) lines.push("## Tasks without a PBI", "", ...orphans.map((t) => `- [${t.status === "done" ? "x" : " "}] ${item(t)}`), "");
	return `${lines.join("\n").trim()}\n`;
}

/** Compact text for agents (backlog_list). */
export function backlogOutline(b: Backlog): string {
	const out: string[] = [`Backlog revision ${b.revision}; approval: ${b.approval.status}${b.approval.comment ? ` (${b.approval.comment})` : ""}`];
	const line = (i: BacklogItem, indent: string) =>
		`${indent}${i.id} [${i.status}${i.assignee ? ` @${i.assignee}` : ""}${i.estimate ? ` ${i.estimate}` : ""}] ${i.title}${i.deps.length ? ` (after ${i.deps.join(", ")})` : ""}${i.area ? ` {${i.area}}` : ""}`;
	for (const f of childrenOf(b, undefined, "feature")) {
		out.push(line(f, ""));
		for (const p of childrenOf(b, f.id, "pbi")) {
			out.push(line(p, "  "));
			for (const c of p.acceptance ?? []) out.push(`      AC: ${c}`);
			for (const t of childrenOf(b, p.id, "task")) out.push(line(t, "    "));
		}
	}
	for (const p of childrenOf(b, undefined, "pbi")) {
		out.push(line(p, "  "));
		for (const t of childrenOf(b, p.id, "task")) out.push(line(t, "    "));
	}
	for (const t of childrenOf(b, undefined, "task")) out.push(line(t, "    "));
	if (out.length === 1) out.push("(empty)");
	return out.join("\n");
}

export type ItemInput = { ref?: string; type: ItemType; parent?: string; title: string; description?: string; acceptance?: string[]; deps?: string[]; area?: string; estimate?: Estimate };

/**
 * Add items in one go. `ref`s let items in the same call point at each other as parent or
 * dependency. Everything is resolved and validated on plain objects first, then each finished
 * item is stored once (a document stores a copy, so later changes to the object would be lost).
 * Throws without changing anything if a parent or dependency is unknown or of the wrong type.
 */
export function addItems(b: Backlog, inputs: ItemInput[], by: string): { id: string; type: ItemType; title: string; parent?: string }[] {
	const seq = { ...b.seq };
	const refs = new Map<string, string>();
	const ids = inputs.map((input) => {
		seq[input.type] += 1;
		const id = `${PREFIX[input.type]}${seq[input.type]}`;
		if (input.ref) refs.set(input.ref, id);
		return id;
	});
	const typeOf = (id: string) => b.items[id]?.type ?? inputs[ids.indexOf(id)]?.type;
	const resolve = (r: string) => refs.get(r) ?? (b.items[r] || ids.includes(r) ? r : undefined);
	let order = Object.keys(b.items).length;
	const made: BacklogItem[] = inputs.map((input, i) => {
		const id = ids[i]!;
		const item: BacklogItem = { id, type: input.type, title: input.title.trim(), status: "todo", deps: [], order: order++, createdBy: by, updatedAt: Date.now() };
		if (input.description) item.description = input.description;
		if (input.acceptance?.length) item.acceptance = input.acceptance;
		if (input.area) item.area = input.area;
		if (input.estimate) item.estimate = input.estimate;
		if (input.parent) {
			const p = resolve(input.parent);
			if (!p) throw new Error(`${id} “${item.title}”: unknown parent "${input.parent}"`);
			if (typeOf(p) !== PARENT_TYPE[input.type]) throw new Error(`${id} “${item.title}”: a ${input.type}'s parent must be a ${PARENT_TYPE[input.type] ?? "(none)"}, not ${typeOf(p)} ${p}`);
			item.parent = p;
		}
		for (const d of input.deps ?? []) {
			const dep = resolve(d);
			if (!dep) throw new Error(`${id} “${item.title}”: unknown dependency "${d}"`);
			if (dep !== id && !item.deps.includes(dep)) item.deps.push(dep);
		}
		return item;
	});
	for (const item of made) b.items[item.id] = item;
	b.seq = seq;
	return made.map(({ id, type, title, parent }) => ({ id, type, title, ...(parent ? { parent } : {}) }));
}
