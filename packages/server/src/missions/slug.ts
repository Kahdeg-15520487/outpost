import { createHash } from "node:crypto";

/**
 * A mission's DNS label, for previews served as `<slug>.<preview.baseDomain>`.
 *
 * - Deterministic (hash of the mission id) so an outpost that lost the metadata still rebuilds the same
 *   label, and short enough that the label never exceeds the 63 bytes DNS allows.
 * - The hash is not cosmetic: two missions called "Website" must not fight over one hostname, and a
 *   renamed mission must not move to a new URL.
 * - ASCII only: non-Latin names degrade to `mission-<hash>` rather than an IDN label.
 */
const MAX_BASE = 56; // 63-byte label limit, minus "-" and six hex characters
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function missionSlug(id: string, name: string): string {
	const base = asciiFold(name)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_BASE)
		.replace(/-+$/, "");
	return `${base || "mission"}-${createHash("sha256").update(id).digest("hex").slice(0, 6)}`;
}

/**
 * True for a single, lowercase DNS label: what a Host header must look like before it is allowed to
 * reach the preview registry. Deliberately stricter than `missionSlug` produces (no dots, no uppercase,
 * no leading or trailing hyphen), so nothing but a generated slug is ever looked up.
 */
export function isPreviewLabel(label: string): boolean {
	return label.length <= 63 && LABEL.test(label);
}

/** "München — Site" → "munchen-site"; anything without ASCII letters or digits becomes empty. */
function asciiFold(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase();
}
