import { useState } from "react";
import type { GateItem, GateReview } from "../api";
import { Markdown } from "./bits";

/**
 * A review in pieces: one row per thing the user is being asked to settle, each with "looks right" or "change this",
 * and the count of how far along it is. The requirements, the design, the backlog and the items added after it all
 * ask the same question, so they ask it with the same card.
 */
export function ReviewChecklist({ items, reviews, disabled, onVerdict, what }: { items: GateItem[]; reviews: Record<string, GateReview>; disabled: boolean; onVerdict: (id: string, verdict?: "ok" | "changes", note?: string) => void; what?: string }) {
	const settled = items.filter((it) => reviews[it.id]?.verdict === "ok").length;
	const flagged = items.filter((it) => reviews[it.id]?.verdict === "changes").length;
	return (
		<>
			<div className="gate-count">
				{settled} of {items.length} looked at{flagged ? ` · ${flagged} change${flagged === 1 ? "" : "s"} requested` : ""}
				<span className="muted"> — say what's fine and what isn't, then approve or send it back.{what ? ` ${what}` : ""}</span>
			</div>
			<ol className="gate-items">
				{items.map((it, i) => (
					<ReviewItem key={it.id} item={it} index={i} review={reviews[it.id]} disabled={disabled} onChange={onVerdict} />
				))}
			</ol>
		</>
	);
}

/**
 * One decision point: fine, or it needs changing. The verdict is stored as it is clicked — a review of a long
 * document, or of a plan, is not something to lose on a reload — while the thing itself is decided once, at the
 * bottom, because a document on `main` is one file and a backlog is one plan.
 */
export function ReviewItem({ item, index, review, disabled, onChange }: { item: GateItem; index: number; review?: GateReview; disabled: boolean; onChange: (id: string, verdict?: "ok" | "changes", note?: string) => void }) {
	const [note, setNote] = useState(review?.verdict === "changes" ? (review.note ?? "") : "");
	const saved = review?.note ?? "";
	const flagged = review?.verdict === "changes";
	return (
		<li className={`gri${review?.verdict === "ok" ? " ok" : ""}${flagged ? " changes" : ""}`}>
			<div className="gri-head">
				<span className="gri-n">{index + 1}</span>
				<span className="gri-title">{item.title}</span>
				<span className="gri-acts">
					<button type="button" className={`btn tiny ghost${review?.verdict === "ok" ? " on" : ""}`} disabled={disabled} aria-pressed={review?.verdict === "ok"} title="This is fine" onClick={() => onChange(item.id, review?.verdict === "ok" ? undefined : "ok")}>
						✓ Looks right
					</button>
					<button type="button" className={`btn tiny ghost${flagged ? " on warn" : ""}`} disabled={disabled} aria-pressed={flagged} title="Say what should change" onClick={() => onChange(item.id, flagged ? undefined : "changes")}>
						✎ Change this
					</button>
				</span>
			</div>
			{item.detail && (
				<div className="gri-detail">
					<Markdown text={item.detail} />
				</div>
			)}
			{flagged && (
				<div className="gri-note">
					<textarea className="input" rows={2} placeholder="What should change?" value={note} onChange={(e) => setNote(e.target.value)} disabled={disabled} />
					<button type="button" className="btn tiny" disabled={disabled || note.trim() === saved} onClick={() => onChange(item.id, "changes", note.trim())}>
						Save note
					</button>
				</div>
			)}
		</li>
	);
}

/** "Approve is off until the flagged items are fine or sent" — the same foot line in every review. */
export function reviewFootNote(items: GateItem[], reviews: Record<string, GateReview>) {
	const flagged = items.filter((it) => reviews[it.id]?.verdict === "changes").length;
	const settled = items.filter((it) => reviews[it.id]?.verdict === "ok").length;
	if (flagged) return "Approve is off until the flagged items are fine or sent";
	return settled === items.length && items.length > 0 ? "Every item looked at" : "Nothing has to be ticked — approve when you're satisfied";
}

/** What "Request changes" starts with: the items already flagged, so the note can just be refined. */
export function changesFromFlags(items: GateItem[], reviews: Record<string, GateReview>) {
	return items
		.filter((it) => reviews[it.id]?.verdict === "changes")
		.map((it) => `- **${it.title}**${reviews[it.id]?.note ? `: ${reviews[it.id]!.note}` : ""}`)
		.join("\n");
}
