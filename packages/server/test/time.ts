/**
 * The app's vocabulary for time passed. It used to return a duration under a day and a date past
 * it, while eight call sites appended " ago" themselves — so a chat from yesterday read "Oct 27 ago"
 * and a fresh one read "just now ago". These checks pin the phrasing so that can't come back.
 */

import { check, finish } from "./lib/harness.ts";
import { timeAgo, timeTitle } from "../../web/src/time.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => timeAgo(Date.now() - ms);

try {
	check("the present is 'just now'", ago(0) === "just now", ago(0));
	check("under a minute is still 'just now'", ago(30_000) === "just now", ago(30_000));
	check("minutes carry their unit", ago(2 * MIN) === "2m ago", ago(2 * MIN));
	check("hours carry theirs", ago(3 * HOUR) === "3h ago", ago(3 * HOUR));
	check("so do days", ago(3 * DAY) === "3d ago", ago(3 * DAY));
	check("a week is a week, not seven days", ago(10 * DAY) === "1w ago", ago(10 * DAY));
	check("a month is a month", ago(45 * DAY) === "1mo ago", ago(45 * DAY));
	check("eleven months does not become a year early", ago(300 * DAY) === "10mo ago", ago(300 * DAY));
	check("a year is never said in months", ago(364 * DAY) === "1y ago", ago(364 * DAY));
	check("a year is a year", ago(400 * DAY) === "1y ago", ago(400 * DAY));

	// The bug itself: no phrase may be a bare date, and none may end up with two "ago"s.
	const ages = [0, 45_000, 5 * MIN, HOUR, 23 * HOUR, DAY, 6 * DAY, 8 * DAY, 29 * DAY, 31 * DAY, 200 * DAY, 364 * DAY, 365 * DAY, 3 * 365 * DAY, 12 * 365 * DAY];
	const phrases = ages.map((age) => ago(age));
	check(
		"every phrase is relative — never a date like 'Oct 27'",
		phrases.every((p) => p === "just now" || /^\d+[a-z]+ ago$/.test(p)),
		phrases,
	);
	check("no phrase stacks two 'ago's", phrases.every((p) => (p.match(/ago/g) ?? []).length <= 1), phrases);
	check("nothing is plural or spelled out", phrases.every((p) => !/ago\b.{0,2}(ago|minute|hour|day|week|month|year)/.test(p)), phrases);
	check("a count is always a whole number above zero", phrases.filter((p) => p !== "just now").every((p) => Number(p.split(/[a-z]/)[0]) >= 1), phrases);
	const shapes = [...new Set(phrases.map((p) => (p === "just now" ? "now" : p.replace(/^\d+/, "N").replace(/ ago$/, ""))))];
	check("the vocabulary is a closed set of units", shapes.every((sh) => ["now", "Nm", "Nh", "Nd", "Nw", "Nmo", "Ny"].includes(sh)), shapes);

	// A tooltip is where the exact moment goes, so the relative phrase never has to carry it.
	const title = timeTitle(Date.now() - 400 * DAY);
	check("the tooltip is the exact moment", /\d{4}/.test(title) && title.length > 8, title);
	check("the tooltip is not the relative phrase", !/ago|just now/.test(title), title);
} catch (error) {
	await finish(error);
}
await finish();
