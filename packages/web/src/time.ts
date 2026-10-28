/**
 * Time as the app says it out loud. Kept dependency-free and in one place so the vocabulary is
 * consistent and can be tested without a browser: "just now", "4m ago", "6d ago", "2w ago",
 * "5mo ago", "2y ago". The unit is part of the phrase, so nothing can glue "ago" onto a date and
 * produce "Oct 27 ago". Abbreviated on purpose: these sit in sidebars and card corners where
 * "3 hours ago" wraps.
 */
export const timeAgo = (t: number) => {
	const s = (Date.now() - t) / 1000;
	if (s < 45) return "just now";
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
	if (s < 86_400) return `${Math.max(1, Math.round(s / 3600))}h ago`;
	const days = Math.round(s / 86_400);
	if (days < 7) return `${days}d ago`;
	if (days < 28) return `${Math.round(days / 7)}w ago`;
	const months = Math.round(days / 30.44);
	// Never "12mo ago": once it is a year's worth of months, say a year.
	if (months < 12) return `${Math.max(1, months)}mo ago`;
	return `${Math.max(1, Math.round(days / 365.25))}y ago`;
};

/** The exact moment, for a tooltip: the relative phrase stays short, this is what hovering reveals. */
export const timeTitle = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
