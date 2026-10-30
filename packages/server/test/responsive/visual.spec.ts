import { expect, test } from "@playwright/test";
import { dynamicText, isPhone, seededChat, seededModule, workspace } from "./helpers.ts";

/**
 * Pixel baselines, one per project and platform (`__snapshots__/<project>/<platform>/…`).
 *
 * Off by default: font rendering differs between Windows and Linux, so a baseline only means
 * something on the platform that made it. Enable with RESPONSIVE_SNAPSHOTS=1 and re-take with
 * `pnpm test:responsive:update` after a deliberate change — and look at the diff before committing.
 */
test.skip(!process.env.RESPONSIVE_SNAPSHOTS, "pixel baselines are per platform: set RESPONSIVE_SNAPSHOTS=1");

/** Nothing may move between runs: font loading, the caret, transitions, and the seeded chat's times. */
async function settle(page: import("@playwright/test").Page) {
	await page.waitForLoadState("networkidle");
	await page.evaluate(() => document.fonts.ready.then(() => true));
	await page.waitForTimeout(250);
}

// Three sizes, five screens. The pages that are mostly static (blueprints, settings, connections) are
// covered by the structural layer; every project here gets its own baseline, so this is the set that has
// to earn its keep — home, the files table, a chat, a module beside its chat, and the login page.
for (const [name, path] of [
	["home", (ws: string) => `#/w/${ws}`],
	["files", (ws: string) => `#/w/${ws}/files`],
] as const) {
	test(`${name}`, async ({ page }) => {
		const ws = await workspace(page);
		await page.goto(`/${path(ws)}`);
		await settle(page);
		await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false, mask: dynamicText(page) });
	});
}

test("chat", async ({ page }) => {
	const ws = await workspace(page);
	const chat = await seededChat(page, ws);
	test.skip(!chat, "the fixture seeded no chat");
	await page.goto(`/#/w/${ws}/c/${chat}`);
	await settle(page);
	await expect(page).toHaveScreenshot("chat.png", { fullPage: false, mask: dynamicText(page) });
});

test("the module beside its chat", async ({ page }, info) => {
	const ws = await workspace(page);
	const chat = await seededChat(page, ws);
	const module = await seededModule(page, ws);
	test.skip(!chat || !module, "the fixture seeded no chat or no module");
	await page.goto(`/#/w/${ws}/c/${chat}?module=${module}`);
	await page.waitForSelector(".gwin");
	await settle(page);
	await expect(page).toHaveScreenshot(isPhone(info.project.name) ? "chat-module-split.png" : "chat-module.png", {
		fullPage: false,
		mask: dynamicText(page),
	});
});

test("the navigation panel", async ({ page }, info) => {
	test.skip(!isPhone(info.project.name) && info.project.name !== "tablet", "the panel only exists on small screens");
	const ws = await workspace(page);
	await page.goto(`/#/w/${ws}`);
	await settle(page);
	await page.locator(".nav-toggle").click();
	await settle(page);
	await expect(page).toHaveScreenshot("nav-panel.png", { fullPage: false, mask: dynamicText(page) });
});

test("the login page", async ({ page }) => {
	await page.context().clearCookies();
	await page.goto("/");
	await settle(page);
	await expect(page).toHaveScreenshot("login.png", { fullPage: false });
});
