/**
 * Artifact embeds: an agent (or a person) puts a line like
 *
 *     ![[f_1a2b3c4d5e6f|Revenue by month]]
 *
 * in a reply and the client renders the file inline, interactive, instead of a link.
 * Parsing is done on segments so a half-written marker mid-stream stays ordinary text.
 */

export type Segment = { kind: "md"; text: string } | { kind: "embed"; id: string; title?: string };

const LINE = /^[ \t]*!\[\[(f_[A-Za-z0-9]{4,})(?:\|([^\]\n]*))?\]\][ \t]*$/;

/** True when the text holds at least one complete marker (cheap gate before splitting). */
export const hasEmbeds = (text: string) => /(^|\n)[ \t]*!\[\[f_[A-Za-z0-9]{4,}/.test(text);

export function splitEmbeds(text: string): Segment[] {
	const lines = text.split("\n");
	const out: Segment[] = [];
	let buf: string[] = [];
	const flush = () => {
		if (!buf.length) return;
		// keep the paragraph break the marker replaced (markdown needs the blank line)
		const chunk = buf.join("\n");
		if (chunk.trim()) out.push({ kind: "md", text: chunk });
		buf = [];
	};
	for (const line of lines) {
		const m = LINE.exec(line);
		if (m) {
			flush();
			out.push({ kind: "embed", id: m[1]!, ...(m[2]?.trim() ? { title: m[2].trim() } : {}) });
		} else buf.push(line);
	}
	flush();
	return out;
}

/** The marker to hand to an agent that wants a file shown inline. */
export const embedMarker = (id: string, title?: string) => `![[${id}${title ? `|${title}` : ""}]]`;
