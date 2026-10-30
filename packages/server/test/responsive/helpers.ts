import { expect, type Page } from "@playwright/test";

/** Which device class a project is, from its name: the CSS answers with the same three buckets. */
export const isPhone = (project: string) => project === "phone";
export const isTablet = (project: string) => project === "tablet";
/** A finger rather than a mouse: the shell switches to the navigation panel under 960px. */
export const hasPanel = (project: string) => isPhone(project) || isTablet(project);
/**
 * Whether the layout stacks the chat under its module. Keep this in step with responsive.css: the
 * three columns stop fitting below 1100px, and the sidebar becomes a panel below 960px.
 */
export const STACK_WIDTH = 1100;
export const stacks = (viewport: { width: number } | null) => (viewport?.width ?? 0) <= STACK_WIDTH;

/** The seeded workspace, read through the signed-in session (the fixture creates exactly one). */
export async function workspace(page: Page): Promise<string> {
	const res = await page.request.get("/api/workspaces");
	expect(res.ok(), "GET /api/workspaces").toBeTruthy();
	const body = await res.json();
	return body.workspaces[0].id as string;
}

/** The chat the fixture seeded, from the homepage payload (there is no chats listing route). */
export async function seededChat(page: Page, ws: string): Promise<string | undefined> {
	const res = await page.request.get(`/api/w/${ws}/home`);
	if (!res.ok()) return undefined;
	const body = await res.json();
	return body.pickup?.lastChat?.id;
}

export async function seededModule(page: Page, ws: string): Promise<string | undefined> {
	const res = await page.request.get(`/api/w/${ws}/modules`);
	if (!res.ok()) return undefined;
	const body = await res.json();
	return body.modules?.[0]?.id;
}

/** The routes that make up the app, in the order the sidebar lists them. */
export const routes = (ws: string) => [
	["home", `#/w/${ws}`],
	["files", `#/w/${ws}/files`],
	["blueprints", `#/w/${ws}/blueprints`],
	["settings", `#/w/${ws}/settings`],
	["connections", `#/w/${ws}/connections`],
] as const;

/** How far the document scrolls sideways — the number that must stay at zero. */
export const sidewaysOverflow = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The app is pinned to the window: the shell is exactly as tall as the viewport, and the page does not scroll. */
export const frame = (page: Page) =>
	page.evaluate(() => ({
		inner: Math.round(innerHeight),
		shell: Math.round(document.querySelector(".shell")!.getBoundingClientRect().height),
		pageScroll: document.documentElement.scrollHeight - innerHeight,
	}));

/**
 * Elements whose text is a time ("2m ago"), a model name that changes with the seed, or anything else
 * that moves between runs. Screenshots mask them rather than hoping they are stable.
 */
export const dynamicText = (page: Page) => [
	page.locator(".ago"),
	page.locator(".home-run-meta"),
	page.locator(".pill"),
	page.locator(".files-table td:nth-child(5)"),
	page.locator(".artifact-sub"),
];

/**
 * Finish running CSS animations and transitions. Anything measured right after a dialog or panel opens
 * would otherwise be caught mid-flight — a sheet 20px below the screen, a panel half way in. Playwright's
 * `animations: "disabled"` only applies to screenshots, not to layout assertions.
 */
export const settleAnimations = (page: Page) => page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
