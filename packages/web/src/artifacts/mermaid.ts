/**
 * Mermaid diagrams, drawn in the browser by pele (Obsidian's renderer): synchronous once loaded,
 * no runtime dependencies, and themed with CSS variables, so a diagram sits on the same paper as
 * the prose around it instead of arriving as a picture with its own palette.
 *
 * Nothing is imported at module scope — the renderer is a lazy chunk, fetched on the first
 * diagram in the workspace and never if nobody writes one.
 */

import DOMPurify from "dompurify";
import { toast } from "../toasts";

type Pele = typeof import("pele");
type Mounted = ReturnType<Pele["mount"]>;

let loading: Promise<Pele> | null = null;

function loadPele(): Promise<Pele> {
	loading ??= import("pele");
	return loading;
}

/** A card is mounted into a live DOM node; this is what the owner must call when it goes away. */
export type DiagramCard = HTMLDivElement & { destroy(): void };

/** Languages that mean "this fence is a diagram": both the Mermaid convention and its file extension. */
const LANGS = new Set(["mermaid", "mmd"]);

export const isDiagramLang = (lang: string) => LANGS.has(lang.trim().toLowerCase());

export const isDiagramFile = (name: string) => /\.(mmd|mermaid)$/i.test(name);

/** The first meaningful word says what kind of diagram it is: `flowchart`, `sequence`, … */
export function diagramKind(source: string): string {
	for (const raw of source.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("%%")) continue;
		const word = line.split(/[\s;]/)[0] ?? "";
		if (/^(flowchart|graph)$/i.test(word)) return "flowchart";
		if (/^sequenceDiagram$/i.test(word)) return "sequence";
		if (/^classDiagram/i.test(word)) return "class";
		if (/^stateDiagram/i.test(word)) return "state";
		if (/^erDiagram$/i.test(word)) return "entity relationship";
		if (/^gantt$/i.test(word)) return "gantt";
		if (/^pie$/i.test(word)) return "pie";
		if (/^journey$/i.test(word)) return "journey";
		if (/^mindmap$/i.test(word)) return "mindmap";
		if (/^timeline$/i.test(word)) return "timeline";
		if (/^quadrantChart$/i.test(word)) return "quadrant";
		if (/^gitGraph$/i.test(word)) return "git graph";
		if (/^(xychart|sankey|block|requirement|C4)/i.test(word)) return word.replace(/[-:].*$/, "").toLowerCase();
		return "diagram";
	}
	return "diagram";
}

/** Every SVG pele produces is escaped at the source; this is the second pair of gloves. */
function sanitize(svg: string): Node {
	return DOMPurify.sanitize(svg, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ["style", "foreignObject"] }) as unknown as Node;
}

function button(label: string, title: string): HTMLButtonElement {
	const el = document.createElement("button");
	el.className = "diagram-btn";
	el.type = "button";
	el.textContent = label;
	el.title = title;
	return el;
}

/** A one-off `<a download>` click, the way the rest of the app saves generated files. */
function save(name: string, svg: string) {
	const a = document.createElement("a");
	a.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	a.download = name;
	a.click();
}

/**
 * Build a diagram card: a bar with what it is and what you can do to it, the drawing underneath,
 * and the source a click away. Mounting is deferred to the next tick so callers can insert the
 * card first — pele measures the container, and a detached node has no width.
 */
export function diagramCard(source: string, options: { name?: string } = {}): DiagramCard {
	const card = document.createElement("div") as DiagramCard;
	card.className = "diagram";
	const kind = diagramKind(source);
	card.dataset.kind = kind;

	const bar = document.createElement("div");
	bar.className = "diagram-bar";

	const badge = document.createElement("span");
	badge.className = "diagram-badge";
	badge.textContent = "Mermaid";
	const kindEl = document.createElement("span");
	kindEl.className = "diagram-kind";
	kindEl.textContent = kind;
	bar.append(badge, kindEl);

	const actions = document.createElement("span");
	actions.className = "diagram-actions";
	const sourceBtn = button("Source", "Show the Mermaid source");
	const copyBtn = button("Copy", "Copy the Mermaid source");
	const svgBtn = button("SVG", "Download the drawing as an SVG file");
	actions.append(sourceBtn, copyBtn, svgBtn);
	bar.append(actions);

	const body = document.createElement("div");
	body.className = "diagram-body";
	body.textContent = "Drawing…";

	const src = document.createElement("pre");
	src.className = "diagram-src";
	src.hidden = true;
	src.textContent = source;

	card.append(bar, body, src);

	let mounted: Mounted | undefined;
	let drawing = false;

	svgBtn.addEventListener("click", () => {
		const svg = mounted?.result?.svg;
		if (!svg) return toast({ kind: "info", text: "The diagram hasn't drawn yet." });
		save(`${options.name ? options.name.replace(/\.[^.]+$/, "") : kind}.svg`, svg);
	});
	copyBtn.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(source);
			toast({ kind: "info", text: "Mermaid source copied." });
		} catch {
			toast({ text: "Couldn't reach the clipboard." });
		}
	});
	sourceBtn.addEventListener("click", () => {
		const showing = !src.hidden;
		src.hidden = showing;
		body.hidden = !showing;
		sourceBtn.classList.toggle("on", !showing);
	});

	card.destroy = () => mounted?.destroy();

	// Draw once the card is in the document, so pele can measure the width it really gets.
	queueMicrotask(() => {
		if (!card.isConnected || drawing) return;
		drawing = true;
		void loadPele()
			.then((pele) => {
				if (!card.isConnected) return;
				body.replaceChildren();
				mounted = pele.mount(body, source, {
					sanitize,
					zoom: "auto",
					onError: () => {
						card.dataset.bad = "1";
						sourceBtn.classList.add("on");
					},
					onRender: () => {
						delete card.dataset.bad;
					},
				});
				if (mounted.error) card.dataset.bad = "1";
			})
			.catch((error) => {
				card.dataset.bad = "1";
				body.textContent = `Couldn't load the diagram renderer: ${error instanceof Error ? error.message : String(error)}`;
			});
	});

	return card;
}
