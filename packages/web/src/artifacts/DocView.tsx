/**
 * Markdown in a chat: rendered, with a table of contents and task-list checkboxes that write
 * back to the file, so a plan or checklist is something the reader can actually tick off.
 */

import { useEffect, useMemo, useRef } from "react";
import { RawMarkdown } from "./RawMarkdown";
import { toast } from "../toasts";

const TASK = /^(\s*)[-*]\s+\[( |x|X)\]\s+/;

export function DocView({ text, editable, onChange }: { text: string; editable?: boolean; onChange?: (next: string) => Promise<void> | void }) {
	const body = useRef<HTMLDivElement>(null);
	const headings = useMemo(() => {
		const out: { level: number; text: string }[] = [];
		for (const line of text.split("\n")) {
			const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
			if (m) out.push({ level: m[1]!.length, text: m[2]!.replace(/[*_`]/g, "") });
		}
		return out;
	}, [text]);

	useEffect(() => {
		const root = body.current;
		if (!root) return;
		const taskLines = text.split("\n").flatMap((line, i) => (TASK.test(line) ? [i] : []));
		const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
		const wired: HTMLInputElement[] = [];
		boxes.forEach((box, i) => {
			box.disabled = !editable;
			if (!editable) return;
			box.classList.add("live");
			const line = taskLines[i];
			box.onclick = (e) => {
				e.preventDefault();
				if (line === undefined || !onChange) return;
				const lines = text.split("\n");
				lines[line] = lines[line]!.replace(/\[( |x|X)\]/, (m) => (/x/i.test(m) ? "[ ]" : "[x]"));
				void Promise.resolve(onChange(lines.join("\n"))).catch((err: Error) => toast({ text: `Could not save: ${err.message}` }));
			};
			wired.push(box);
		});
		return () => wired.forEach((box) => (box.onclick = null));
	}, [text, editable, onChange]);

	return (
		<div className="art-doc">
			{headings.length > 1 && (
				<div className="art-toc">
					<div className="label">On this page</div>
					{headings.map((h, i) => (
						<button
							key={i}
							className={`art-toc-item l${h.level}`}
							onClick={() => body.current?.querySelectorAll("h1, h2, h3")[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" })}
							title={h.text}
						>
							{h.text}
						</button>
					))}
				</div>
			)}
			<div className="art-doc-body" ref={body}>
				<RawMarkdown text={text} />
			</div>
		</div>
	);
}
