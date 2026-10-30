import { expect, test } from "@playwright/test";
import { frame, hasPanel, isPhone, isTablet, routes, seededChat, seededModule, settleAnimations, sidewaysOverflow, stacks, workspace } from "./helpers.ts";

/**
 * Structural truth at each breakpoint: what is visible, what is reachable, and what must never
 * overflow. These run on every project and are the layer that is allowed to fail the build.
 */

test.describe("the shell", () => {
	test("the app fills the window and never scrolls as a page", async ({ page }) => {
		const ws = await workspace(page);
		for (const [name, route] of routes(ws)) {
			await page.goto(`/${route}`);
			await page.waitForSelector(".shell");
			const box = await frame(page);
			expect(box.shell, `${name}: the shell is the height of the window`).toBe(box.inner);
			expect(box.pageScroll, `${name}: the page itself does not scroll`).toBe(0);
			expect(await sidewaysOverflow(page), `${name}: no sideways overflow`).toBeLessThanOrEqual(0);
		}
	});

	test("navigation is a panel on small screens and docked on large ones", async ({ page }, info) => {
		const ws = await workspace(page);
		await page.goto(`/#/w/${ws}`);
		const toggle = page.locator(".nav-toggle");
		const sidebar = page.locator(".sidebar");
		if (hasPanel(info.project.name)) {
			await expect(toggle).toBeVisible();
			await expect(sidebar).not.toBeInViewport();
			await toggle.click();
			await expect(sidebar).toBeInViewport();
			await expect(page.locator(".nav-scrim")).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(sidebar).not.toBeInViewport();
			await expect(page.locator(".nav-scrim")).toHaveCount(0);
		} else {
			await expect(toggle).toBeHidden();
			await expect(sidebar).toBeInViewport();
		}
	});

	test("every sidebar section folds", async ({ page }) => {
		const ws = await workspace(page);
		await page.goto(`/#/w/${ws}`);
		if (hasPanel(test.info().project.name)) await page.locator(".nav-toggle").click();
		const head = page.locator('[data-section="chats"] .side-section-toggle');
		await expect(head).toBeVisible();
		await expect(head).toHaveAttribute("aria-expanded", "true");
		await head.click();
		await expect(head).toHaveAttribute("aria-expanded", "false");
		await expect(page.locator("[data-chat-id]")).toHaveCount(0);
		await expect(head).toContainText("▸");
	});
});

test.describe("a chat and its module", () => {
	test("side by side on a wide window, stacked on a phone", async ({ page }, info) => {
		const ws = await workspace(page);
		const chat = await seededChat(page, ws);
		const module = await seededModule(page, ws);
		test.skip(!chat || !module, "the fixture seeded no chat or no module");
		await page.goto(`/#/w/${ws}/c/${chat}?module=${module}`);
		await page.waitForSelector(".gwin");

		const gwin = (await page.locator(".gwin").boundingBox())!;
		const main = (await page.locator(".main").boundingBox())!;
		if (stacks(page.viewportSize())) {
			// Stacked: module on top, the chat it was opened from underneath, a divider between them.
			expect(gwin.y + gwin.height, "the module sits above the chat").toBeLessThanOrEqual(main.y + 1);
			await expect(page.locator(".shell-split")).toBeVisible();
			await expect(page.locator(".main .composer textarea")).toBeVisible();
		} else {
			// Beside each other: the module to the right of the chat.
			expect(gwin.x, "the module sits to the right of the chat").toBeGreaterThanOrEqual(main.x + main.width - 1);
		}
		expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
	});

	test("a module scaled on a phone keeps its desktop layout", async ({ page }, info) => {
		test.skip(!isPhone(info.project.name), "only phones scale the frame");
		const ws = await workspace(page);
		const module = await seededModule(page, ws);
		test.skip(!module, "the fixture seeded no module");
		await page.goto(`/#/w/${ws}/modules/${module}`);
		await page.waitForSelector(".gwin-frame iframe");
		const box = await page.locator(".gwin-frame iframe").evaluate((f) => ({
			layout: (f as HTMLIFrameElement).offsetWidth,
			shown: Math.round(f.getBoundingClientRect().width),
			transform: getComputedStyle(f).transform,
		}));
		expect(box.layout, "laid out at a desktop width").toBeGreaterThan(box.shown + 100);
		expect(box.transform).toMatch(/^matrix\(0?\.\d/);
	});

	test("Chat in the module bar gives it the whole window, and gives it back", async ({ page }, info) => {
		test.skip(!isPhone(info.project.name), "only phones split");
		const ws = await workspace(page);
		const chat = await seededChat(page, ws);
		const module = await seededModule(page, ws);
		test.skip(!chat || !module, "the fixture seeded no chat or no module");
		await page.goto(`/#/w/${ws}/c/${chat}?module=${module}`);
		await page.waitForSelector(".gwin-chat");
		await page.locator(".gwin-chat").click();
		await expect(page.locator(".main")).toBeHidden();
		await page.locator(".gwin-chat").click();
		await expect(page.locator(".main")).toBeVisible();
	});
});

test.describe("dialogs", () => {
	test("a sheet on a phone, a centred dialog on a desktop", async ({ page }, info) => {
		const ws = await workspace(page);
		await page.goto(`/#/w/${ws}/files`);
		const row = page.locator(".files-table tbody tr .fname a").first();
		// The table is filled by a fetch after mount: wait for it instead of reading an empty page.
		await page.waitForSelector(".files-table tbody tr", { timeout: 15_000 }).catch(() => undefined);
		test.skip(!(await row.count()), "the fixture seeded no files");
		await row.click();
		const dialog = page.locator(".dialog");
		await expect(dialog).toBeVisible();
		await settleAnimations(page);
		const box = (await dialog.boundingBox())!;
		const view = page.viewportSize()!;
		if (isPhone(info.project.name)) {
			expect(Math.round(box.width), "full width").toBe(view.width);
			expect(Math.round(box.y + box.height), "pinned to the bottom edge").toBe(view.height);
		} else {
			expect(box.width, "not full width on a desktop").toBeLessThan(view.width);
			expect(box.y, "not pinned to the bottom").toBeLessThan(view.height - 50);
		}
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
	});
});

test.describe("touch", () => {
	test("fields are 16px so iOS does not zoom into them", async ({ page }, info) => {
		test.skip(!isPhone(info.project.name) && !isTablet(info.project.name), "touch devices only");
		const ws = await workspace(page);
		const chat = await seededChat(page, ws);
		test.skip(!chat, "the fixture seeded no chat");
		await page.goto(`/#/w/${ws}/c/${chat}`);
		const size = await page.locator(".composer textarea").evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
		expect(size).toBeGreaterThanOrEqual(16);
	});

	test("targets are big enough for a thumb", async ({ page }, info) => {
		test.skip(!isPhone(info.project.name) && !isTablet(info.project.name), "touch devices only");
		const ws = await workspace(page);
		await page.goto(`/#/w/${ws}`);
		const small = await page.locator(".side-item, .nav-toggle, .btn").evaluateAll((els) =>
			els
				.filter((e) => (e as HTMLElement).offsetParent !== null)
				.map((e) => ({ label: (e as HTMLElement).innerText.trim().slice(0, 24), height: Math.round(e.getBoundingClientRect().height) }))
				.filter((e) => e.height > 0 && e.height < 32),
		);
		expect(small, `too small: ${JSON.stringify(small)}`).toHaveLength(0);
	});
});

test.describe("the login page", () => {
	test("fits every screen", async ({ page }) => {
		await page.context().clearCookies();
		await page.goto("/");
		await expect(page.locator(".auth-form form")).toBeVisible();
		expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
		const box = (await page.locator(".auth-form form").boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
	});
});
