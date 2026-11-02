/**
 * What a team should know about the rest of the workspace before it designs anything.
 *
 * A mission's product is its own repository: modules (sandboxed apps with a QuickJS server) live outside it
 * and cannot be installed into `app/` or called from it. But the workspace may already do part of the job, and
 * a team that designs a second contacts app next to the user's Contacts module has wasted the user's money.
 * This section names what exists so the design can point at it — as a companion and an import/export path —
 * instead of silently rebuilding it.
 */
import { blueprints as blueprintDb, modules as moduleDb } from "../kernel/system-db.ts";
import type { Workspace } from "../kernel/workspace.ts";

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function existingAppsSection(ws: Workspace): string | undefined {
	const live = moduleDb.inWorkspace(ws.id);
	const templates = blueprintDb.visibleLatest(ws.row.ownerId);
	if (!live.length && !templates.length) return undefined;
	const lines = [
		"The workspace's other apps. They are **not** part of your repository — a module runs in Outpost's sandbox (client + QuickJS server with durable storage), so you cannot install one into `app/` or call it from your product. Don't design something they already do:",
	];
	if (live.length) lines.push(`Modules the user has: ${live.map((m) => `“${m.name}”`).join(", ")}.`);
	if (templates.length)
		lines.push(`Blueprints they can build from (module code you could ask about, not code you can copy into \`app/\`): ${templates.map((b) => `“${b.name}” v${b.version}${b.description ? ` (${clip(b.description.replace(/\s+/g, " "), 100)})` : ""}`).join(", ")}.`);
	lines.push(
		"If one of these covers part of the goal, say so in `docs/design.md` as the companion the user keeps — and how the two exchange data (an export, a copy-paste format) — rather than rebuilding it. If the whole goal is a small app of that kind, say so before designing a product: the user may prefer a module, which is delivered in minutes.",
	);
	return lines.join("\n");
}
