import type { Backlog, BacklogItem } from "./backlog.ts";
import type { MissionRepo } from "./repo.ts";
import { retroActions } from "./retro.ts";

/**
 * Story-style briefs: what a developer needs to start a task without re-reading every document. The
 * planner names the context a task needs (`context: ["docs/design.md#Data model", "docs/decisions/0003-auth.md"]`);
 * outpost inlines those excerpts from main into the brief, with the decision index, the design's
 * outline and what the task's dependencies delivered. Bounded so a brief stays readable.
 */
const SECTION_MAX = 4000;
const FILE_MAX = 3000;
const TOTAL_MAX = 12000;

const norm = (s: string) => s.toLowerCase().replace(/[`*_]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

type Heading = { line: number; level: number; text: string };
function headings(md: string): Heading[] {
	const out: Heading[] = [];
	let fence = false;
	md.split("\n").forEach((l, i) => {
		if (/^\s*```/.test(l)) fence = !fence;
		const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
		if (m) out.push({ line: i, level: m[1]!.length, text: m[2]! });
	});
	return out;
}

/** The section under a heading (matched loosely: case, punctuation and numbering don't matter), up to the next heading of the same or a higher level. */
export function extractSection(md: string, heading: string): string | undefined {
	const want = norm(heading.replace(/^#+/, ""));
	if (!want) return undefined;
	const hs = headings(md);
	const strip = (t: string) => norm(t).replace(/^(\d+ )+/, "");
	const h = hs.find((x) => norm(x.text) === want || strip(x.text) === want.replace(/^(\d+ )+/, "")) ?? hs.find((x) => norm(x.text).includes(want));
	if (!h) return undefined;
	const next = hs.find((x) => x.line > h.line && x.level <= h.level);
	return md.split("\n").slice(h.line, next ? next.line : undefined).join("\n").trim();
}

/** The outline of a markdown document (its ## and ### headings). */
export function outline(md: string): string[] {
	return headings(md)
		.filter((h) => h.level >= 2 && h.level <= 3)
		.map((h) => `${h.level === 3 ? "  " : ""}- ${h.text}`);
}

const cap = (s: string, n: number, hint: string) => (s.length > n ? `${s.slice(0, n).trimEnd()}\n… (cut; ${hint})` : s);

/** Markdown sections for a task's brief. */
export async function storyContext(repo: MissionRepo, b: Backlog, t: BacklogItem): Promise<string> {
	const parts: string[] = [];
	let used = 0;
	const add = (title: string, body: string) => {
		if (!body.trim() || used >= TOTAL_MAX) return;
		const room = TOTAL_MAX - used;
		const text = cap(body.trim(), room, "read the file for the rest");
		used += text.length;
		parts.push(`### ${title}\n${text}`);
	};
	const read = async (path: string) => (await repo.read(path).catch(() => undefined))?.text;

	// 1. What the planner said this task needs.
	const missing: string[] = [];
	for (const ref of t.context ?? []) {
		const [path, anchor] = ref.split("#", 2) as [string, string | undefined];
		const text = await read(path.trim());
		if (!text) {
			missing.push(ref);
			continue;
		}
		if (anchor) {
			const section = extractSection(text, anchor);
			if (section) add(`${path} § ${anchor}`, cap(section, SECTION_MAX, `see ${path}`));
			else missing.push(ref);
		} else add(path, cap(text, FILE_MAX, `see ${path}`));
	}

	// 2. What the team decided to do differently after the last build.
	if (b.build?.retro) {
		const actions = retroActions((await read(b.build.retro)) ?? "");
		if (actions.length) add(`Lessons from the last retrospective (${b.build.retro})`, actions.map((a) => `- ${a}`).join("\n"));
	}

	// 3. What the dependencies delivered.
	const deps = t.deps.map((d) => b.items[d]).filter((d): d is BacklogItem => !!d?.submitted);
	if (deps.length) add("What your dependencies delivered", deps.map((d) => `- ${d.id} ${d.title}: ${d.submitted!.summary} (files: ${d.submitted!.files.slice(0, 8).join(", ")}${d.submitted!.files.length > 8 ? ", …" : ""})`).join("\n"));

	// 3. Where to look for the rest.
	const files = await repo.files().catch(() => [] as string[]);
	const decisions = files.filter((f) => /^docs\/decisions\/\d{4}-.+\.md$/.test(f)).sort();
	if (decisions.length) {
		const titles = await Promise.all(decisions.map(async (f) => `- ${f}: ${(/^#\s+(.+)$/m.exec((await read(f)) ?? "")?.[1] ?? "").trim()}`));
		add("Decision records (follow them; supersede, never rewrite)", titles.join("\n"));
	}
	if (!(t.context ?? []).some((r) => r.startsWith("docs/design.md"))) {
		const design = await read("docs/design.md");
		if (design) add("Outline of docs/design.md (read the sections you need)", outline(design).join("\n"));
	}
	if (missing.length) parts.push(`(Not found on main: ${missing.join(", ")}. Look for the current place in the docs.)`);
	return parts.join("\n\n");
}
