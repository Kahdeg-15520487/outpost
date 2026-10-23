import type { Backlog, BacklogItem } from "./backlog.ts";

/**
 * The retrospective pi-os writes when a build finishes: facts from the backlog's history (review
 * rounds, test failures, conflicts, blocks, cycle times) and tokens per agent. The lead adds what went
 * well, what to improve and actions (retro_notes); later briefs carry those actions as lessons.
 */
const count = (t: BacklogItem, re: RegExp) => (t.history ?? []).filter((h) => re.test(h.text)).length;
const minutes = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

export function retroFacts(b: Backlog, tokens: Record<string, number>, n: number, projectName: string): string {
	const tasks = Object.values(b.items)
		.filter((i) => i.type === "task")
		.sort((x, y) => x.order - y.order);
	const done = tasks.filter((t) => t.status === "done");
	const rows = done.map((t) => {
		const changes = count(t, /^Changes requested/);
		const failures = count(t, /^Tests fail/);
		const conflicts = count(t, /^Merge conflict/);
		const blocked = count(t, /^Blocked/);
		const start = (t.history ?? []).find((h) => /^Assigned/.test(h.text))?.at;
		const end = (t.history ?? []).findLast((h) => /^Merged into main/.test(h.text))?.at;
		return { t, changes, failures, conflicts, blocked, cycle: start && end ? end - start : undefined };
	});
	const firstTime = rows.filter((r) => !r.changes && !r.failures && !r.conflicts).length;
	const sum = (k: "changes" | "failures" | "conflicts" | "blocked") => rows.reduce((a, r) => a + r[k], 0);
	const cycles = rows.map((r) => r.cycle).filter((c): c is number => c !== undefined);
	const byDev = new Map<string, number>();
	for (const r of rows) if (r.t.assignee) byDev.set(r.t.assignee, (byDev.get(r.t.assignee) ?? 0) + 1);
	const span = b.build?.startedAt && b.build?.finishedAt ? b.build.finishedAt - b.build.startedAt : undefined;
	const lines = [
		`# Retrospective ${String(n).padStart(4, "0")}: ${projectName}`,
		"",
		`> Written by pi-os when the build finished (${new Date().toISOString().slice(0, 10)}). The facts come from the backlog's history; the lead adds the lessons below. Later briefs carry the actions.`,
		"",
		"## Facts",
		"",
		`- **${done.length} task${done.length === 1 ? "" : "s"}** merged${span ? ` in ${minutes(span)}` : ""}.`,
		`- **${firstTime} of ${done.length}** passed review and tests the first time.`,
		`- Review rounds sent back: **${sum("changes")}** · test failures: **${sum("failures")}** · merge conflicts: **${sum("conflicts")}** · blocked: **${sum("blocked")}**.`,
		...(cycles.length ? [`- Cycle time per task (assigned → merged): median **${minutes([...cycles].sort((a, c) => a - c)[Math.floor(cycles.length / 2)]!)}**, longest **${minutes(Math.max(...cycles))}**.`] : []),
		...(byDev.size ? [`- Tasks per developer: ${[...byDev].map(([k, v]) => `@${k} ${v}`).join(", ")}.`] : []),
		...(Object.keys(tokens).length ? [`- Tokens per agent: ${Object.entries(tokens)
			.sort((a, c) => c[1] - a[1])
			.map(([k, v]) => `@${k} ${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`)
			.join(", ")}.`] : []),
		"",
		"| Task | Developer | Sent back | Test failures | Conflicts | Cycle |",
		"|---|---|---|---|---|---|",
		...rows.map((r) => `| ${r.t.id} ${r.t.title.replace(/\|/g, "/")} | ${r.t.assignee ? `@${r.t.assignee}` : ""} | ${r.changes} | ${r.failures} | ${r.conflicts} | ${r.cycle !== undefined ? minutes(r.cycle) : ""} |`),
		"",
		"## Lessons",
		"",
		"_Waiting for the lead._",
		"",
	];
	return lines.join("\n");
}

export function retroLessons(notes: { went_well: string[]; to_improve: string[]; actions: string[] }): string {
	const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
	return `## Lessons\n\n### What went well\n${list(notes.went_well)}\n\n### What to improve\n${list(notes.to_improve)}\n\n### Actions\n${list(notes.actions)}\n`;
}

/** The actions of the latest retrospective, for briefs. */
export function retroActions(md: string): string[] {
	const m = /### Actions\n([\s\S]*?)(\n#|$)/.exec(md);
	return (m?.[1] ?? "")
		.split("\n")
		.map((l) => l.replace(/^-\s*/, "").trim())
		.filter((l) => l && l !== "(none)");
}
