/**
 * What a document review asks for, in pieces.
 *
 * "Approve the requirements" is one click for a document that took a team an hour and reads like a wall of
 * prose. So a request carries *items* — the decisions the lead wants checked — and the user settles them one at
 * a time: looks right, or say what should change. The gate still resolves as a whole (a document on `main` is
 * one file, and git has no half-approval), but the review is a checklist instead of a yes/no on 3000 words.
 *
 * Requests made before items existed only have a `summary`; the bullets in it are read back as items so an
 * existing pending review gets the same checklist. Parsed ids are `p1…`, explicit ids `i1…`, so a review of a
 * parsed item can never be mistaken for a review of a new one.
 */
import type { DocGate, GateItem, GateReview, MissionState } from "./docs.ts";

const MAX_ITEMS = 20;

/** `- **Luồng chính**: viết câu hỏi…` → title `Luồng chính`, detail `viết câu hỏi…`. */
function splitItem(line: string): { title: string; detail?: string } {
	const bold = /^\*\*(.+?)\*\*\s*[:—-]?\s*(.*)$/.exec(line);
	if (bold) return bold[2]!.trim() ? { title: bold[1]!.trim(), detail: bold[2]!.trim() } : { title: bold[1]!.trim() };
	return { title: line.trim() };
}

/** Items a request carries: what the lead listed, or the bullets of its summary for older requests. */
export function gateItems(g: DocGate | undefined): GateItem[] {
	if (!g) return [];
	if (g.items?.length) return g.items;
	const text = g.summary ?? "";
	if (!text) return [];
	const items: { title: string; detail?: string }[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const bullet = /^\s{0,3}(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
		if (bullet) {
			if (items.length >= MAX_ITEMS) break;
			items.push(splitItem(bullet[1]!));
		} else if (items.length && /^\s+\S/.test(line)) {
			// a wrapped or indented line belongs to the item above it
			const last = items[items.length - 1]!;
			last.detail = last.detail ? `${last.detail} ${line.trim()}` : line.trim();
		}
	}
	return items.map((it, i) => ({ id: `p${i + 1}`, ...it }));
}

/** Reviews in item order, so a view can say "3 of 6 settled" without looking at keys. */
export function gateReview(g: DocGate | undefined, id: string): GateReview | undefined {
	return g?.reviews?.[id];
}

/** Items the user marked as needing a change. */
export function flaggedItems(g: DocGate | undefined): GateItem[] {
	return gateItems(g).filter((it) => g?.reviews?.[it.id]?.verdict === "changes");
}

/** The change request the team gets, when the user flagged items instead of writing a paragraph. */
export function changesFromItems(g: DocGate | undefined): string {
	const flagged = flaggedItems(g);
	if (!flagged.length) return "";
	return flagged.map((it) => `- **${it.title}**${g!.reviews![it.id]!.note ? `: ${g!.reviews![it.id]!.note}` : ""}`).join("\n");
}

/**
 * Mission state as the browser sees it: gates carry the items they are actually asking about, whether the lead
 * listed them or they were read back out of an older summary.
 */
export function withGateItems(state: MissionState | null | undefined): MissionState | null | undefined {
	if (!state?.gates) return state;
	const gates: NonNullable<MissionState["gates"]> = {};
	for (const [name, g] of Object.entries(state.gates)) {
		if (!g) continue;
		const items = gateItems(g);
		gates[name as keyof NonNullable<MissionState["gates"]>] = items.length ? { ...g, items } : g;
	}
	return { ...state, gates };
}
