/**
 * Browser test of the web app against a real (in-process) outpost: chat, sidebar menus, the model
 * picker, and the mission page (layouts, tiles, attachments, repo tree, backlog build bar, item
 * history, live preview). Needs Chrome, Edge or Chromium (or OUTPOST_CHROME) and a built web app
 * (pnpm build). Run: pnpm --filter @outpost/server test:ui   (HEADFUL=1 to watch)
 */
import { check, finish, must, sleep, startServer, until, passDocGates } from "./lib/harness.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";

const { config } = await import("../src/config.ts");
const { findBrowser } = await import("../src/modules/render.ts");
const browserPath = findBrowser();
if (!browserPath) {
	console.log("  - skipped: no Chrome/Edge/Chromium found (set OUTPOST_CHROME)");
	await finish();
}
if (!existsSync(join(config.webDist, "index.html"))) await finish(new Error("The web app isn't built: run `pnpm build` first"));

const base = await startServer();
const { Workspace } = await import("../src/kernel/workspace.ts");
const { users } = await import("../src/kernel/system-db.ts");
const { addItems } = await import("../src/missions/backlog.ts");
const { DEFAULT_DOD } = await import("../src/missions/checks.ts");

let page: Page;

// ------------------------------------------------------------------ helpers

async function api(method: string, path: string, body?: unknown) {
	return page.evaluate(
		async (method, path, body) => {
			const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
			const t = await r.text();
			if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t}`);
			return t ? JSON.parse(t) : {};
		},
		method,
		path,
		body as any,
	);
}
const go = async (hash: string) => {
	await page.goto(`${base}/${hash}`);
	await page.reload();
	await sleep(400);
};
/** SHOTS=<dir> saves screenshots of key screens (for looking at the UI, not for assertions). */
const shot = async (name: string) => {
	if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `ui-${name}.png`) });
};
const text = (sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText).catch(() => "");
const count = (sel: string) => page.$$eval(sel, (es) => es.length);
const clickText = (sel: string, label: string | RegExp) =>
	page.evaluate(
		(sel, src, flags) => {
			const re = new RegExp(src, flags);
			const el = [...document.querySelectorAll(sel)].find((e) => re.test((e as HTMLElement).innerText.trim()));
			(el as HTMLElement | undefined)?.click();
			return !!el;
		},
		sel,
		typeof label === "string" ? `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` : label.source,
		typeof label === "string" ? "" : label.flags,
	);

// ------------------------------------------------------------------ the run

async function run() {
	console.log("shell + chat");
	await page.goto(base);
	await page.waitForSelector(".auth-form");
	check("login uses the Outpost name and mark", await page.title() === "Outpost" && await text(".brand .name") === "Outpost" && !!(await page.$('.brand img[src="/outpost.svg"]')));
	await shot("outpost-login");
	await api("POST", "/api/auth/signup", { username: "ana", password: "password123", displayName: "Ana" });
	const ws = (await api("GET", "/api/workspaces")).workspaces[0].id as string;
	await go("");
	must("signed in: the shell shows the sidebar", await until("sidebar", () => page.$(".new-chat")));
	check("sidebar uses Outpost, Missions and Modules", await text(".brand .name") === "Outpost" && /missions/i.test(await text(".side-scroll")) && /modules/i.test(await text(".side-scroll")));

	await page.click(".new-chat");
	await page.waitForSelector(".composer textarea");
	await page.type(".composer textarea", "hello there");
	await page.keyboard.press("Enter");
	check("my message shows", await until("user message", () => text(".msg-user").then((t) => t.includes("hello there"))));
	check("the agent answers (demo model)", await until("assistant", () => text(".msg-assistant").then((t) => t.length > 20)));

	const chatRow = await until("chat in sidebar", () => page.$(".side-section .row-menu-btn"));
	check("the chat is listed in the sidebar", chatRow);
	if (chatRow) {
		await page.evaluate(() => (document.querySelector(".side-section .row-menu-btn") as HTMLElement).click());
		await page.waitForSelector(".row-menu");
		await clickText(".row-menu [role=menuitem], .row-menu button", /Rename/);
		const input = await until("rename input", () => page.$(".side-item.editing input"));
		if (input) {
			await input.evaluate((i) => (i as HTMLInputElement).select());
			await input.type("Renamed chat");
			await page.keyboard.press("Enter");
		}
		check("rename from the ⋯ menu", await until("renamed", () => page.$$eval(".side-item .t", (ts) => ts.some((t) => t.textContent === "Renamed chat"))));
	}

	console.log("account menu + collapsible sidebar");
	const sidebarW = () => page.$eval(".sidebar", (e) => Math.round(e.getBoundingClientRect().width)).catch(() => 0);
	check("no bare Sign out button in the footer", (await page.$(".side-foot > button.who-btn")) !== null && !(await page.$$eval(".side-foot > button", (bs) => bs.some((b) => /sign out/i.test(b.textContent ?? "")))));
	check("the footer shows the user's name", (await text(".who-btn .who")) === "Ana");
	await page.click(".who-btn");
	check("clicking the name opens a menu with Sign out", await until("user menu", () => page.$$eval(".user-menu [role=menuitem]", (is) => is.some((i) => /sign out/i.test(i.textContent ?? "")))));
	await shot("user-menu");
	await page.keyboard.press("Escape");
	check("Escape closes the menu", await until("menu closed", async () => !(await page.$(".user-menu"))));
	await page.click(".who-btn");
	await page.mouse.click(900, 300);
	check("clicking elsewhere closes the menu", await until("menu closed 2", async () => !(await page.$(".user-menu"))));

	check("the sidebar starts open", (await sidebarW()) > 200 && !(await page.$(".side-reveal")));
	await page.click(".side-hide");
	check("the hide button tucks the sidebar away", await until("collapsed", async () => (await sidebarW()) === 0));
	check("a small button to show it again appears", !!(await page.$(".side-reveal")));
	const mainLeft = await page.$eval(".main", (e) => Math.round(e.getBoundingClientRect().left));
	check("the page takes the freed space (starts at the left edge)", mainLeft === 0, mainLeft);
	await shot("sidebar-collapsed");
	await page.reload();
	await page.waitForSelector(".composer textarea");
	check("the choice survives a reload", (await sidebarW()) === 0 && !!(await page.$(".side-reveal")));
	await page.click(".side-reveal");
	check("the reveal button brings it back", await until("reopened", async () => (await sidebarW()) > 200) && !(await page.$(".side-reveal")));
	await page.reload();
	await page.waitForSelector(".composer textarea");
	check("…and that survives a reload too", (await sidebarW()) > 200);

	const chatUrl = page.url();
	await page.click(".who-btn");
	await clickText(".user-menu [role=menuitem]", "Sign out");
	check("Sign out in the menu signs you out", await until("login form", () => page.$(".auth-form form")));
	await api("POST", "/api/auth/login", { username: "ana", password: "password123" });
	await page.goto(chatUrl);
	await page.reload();
	must("signed back in", await until("composer again", () => page.$(".composer textarea")));

	console.log("model picker");
	await page.reload();
	await page.waitForSelector(".composer select");
	// (1-based so a first-position select isn't falsy)
	const found = await until("model select", () => page.$$eval(".composer select", (ss) => ss.findIndex((s) => [...(s as HTMLSelectElement).options].some((o) => o.value === "__manage")) + 1));
	must("the chat has a model dropdown", typeof found === "number" && found > 0);
	const selectWithManage = found - 1;
	const openPicker = async () => {
		await page.$$eval(".composer select", (ss, i) => {
			const s = ss[i] as HTMLSelectElement;
			s.value = "__manage";
			s.dispatchEvent(new Event("change", { bubbles: true }));
		}, selectWithManage);
		must("Choose models… opens the picker", await until("picker", () => page.$(".mp-dialog")));
		// the dialog lists models it has loaded; saving an empty list would mean "everything"
		await until("the model list", () => page.$(".mp-provider"), 15000);
	};
	const offers = () => page.$$eval(".composer select option", (os) => (os as HTMLOptionElement[]).filter((o) => !o.disabled).map((o) => o.value).filter((v) => v && v !== "__manage"));
	// The test config has the offline demo and nothing else — by design, so a test run can never call a
	// paid API. So what we can check here is the picker's own contract: everything checked is stored as
	// "everything" (the key disappears), and an empty selection cannot be saved at all.
	await openPicker();
	await clickText(".mp-dialog button", "Uncheck all");
	const saveState = await page.evaluate(() => {
		const b = [...document.querySelectorAll(".mp-dialog button")].find((x) => /^Save/.test((x as HTMLElement).innerText.trim())) as HTMLButtonElement | undefined;
		return b ? { disabled: b.disabled, title: b.title } : undefined;
	});
	check("an empty picker cannot be saved", Boolean(saveState?.disabled) && /at least one/.test(saveState?.title ?? ""), saveState);
	await clickText(".mp-dialog button", "Check all");
	await clickText(".mp-dialog button", "Save");
	await until("dialog closed", async () => !(await page.$(".mp-dialog")));
	const picker = (await api("GET", "/api/models")).picker;
	check("a fully checked provider is stored as 'everything' (key omitted)", picker["outpost-demo"] === undefined, picker);
	const options = await offers();
	check("the dropdown offers only the picked models", options.length > 0 && options.every((v) => v.startsWith("outpost-demo/")), options);
	const hidden = (await api("PUT", "/api/me/model-picker", { picker: { "outpost-demo": [] } })).picker;
	check("a hidden provider is stored as an empty list, not 'everything'", Array.isArray(hidden["outpost-demo"]) && hidden["outpost-demo"].length === 0, hidden);
	await api("PUT", "/api/me/model-picker", { picker: {} });

	console.log("export / import");
	const bundlePath = join(process.env.OUTPOST_DATA!, "..", "import.outpost.json");
	writeFileSync(
		bundlePath,
		JSON.stringify({ format: "outpost/bundle", version: 2, exportedAt: new Date().toISOString(), blueprints: [{ name: "Imported board", description: "from elsewhere", icon: "▦", files: { "index.html": "<h1>board</h1>" } }], modules: [
				{ name: "Imported module", icon: "◆", files: { "index.html": "<h1>hi</h1>" }, data: { count: 3 } },
				{ name: "Needs teleport", icon: "◆", files: { "index.html": "<h1>x</h1>", "server.js": "export default class S { constructor(ctx) { this.ctx = ctx; } go() { return this.ctx.teleport(); } }" } },
			] }),
	);
	await go(`#/w/${ws}/blueprints`);
	must("Blueprints page has Import and Export", await until("buttons", () => page.$$eval(".bp-head button", (bs) => bs.map((b) => b.textContent).join()).then((t) => /Import/.test(t) && /Export/.test(t))));
	await clickText(".bp-head button", "Import…");
	const fileInput = await until("file input", () => page.$(".tx-drop input[type=file]"));
	await (fileInput as any).uploadFile(bundlePath);
	check("import shows what the file holds before importing", await until("preview", () => text(".tx-preview").then((t) => /Imported board/.test(t) && /Imported module/.test(t) && /with data/.test(t))));
	check("import checks each item against this outpost (version + capabilities)", /producer version not recorded/.test(await text(".tx-producer")) && (await count(".tx-check li.ok")) === 2 && (await count(".tx-check li.blocked")) === 1 && /ctx\.teleport/.test(await text(".tx-check li.blocked")));
	check("the import button counts only what can run", /Import 2 of 3/.test(await text(".tx-dialog .btn.primary")));
	await shot("import");
	await clickText(".tx-dialog button", /^Import/);
	check("import result lists the new blueprint and module", await until("result", () => text(".tx-dialog").then((t) => /imported/i.test(t) && /in your library/i.test(t) && /Imported module/.test(t))));
	check("the result says what wasn't imported and why", /not imported/i.test(await text(".tx-dialog")) && /Needs teleport/.test(await text(".tx-dialog")));
	await clickText(".tx-dialog button", "Done");
	check("the imported blueprint is in the library", await until("listed", () => page.$$eval(".bp-grid .bp .n", (ns) => ns.some((n) => n.textContent === "Imported board"))));
	check("the imported module is in the sidebar", await until("sidebar module", () => page.$$eval(".side-item .t", (ts) => ts.some((t) => t.textContent === "Imported module"))));

	// Archive: out of the sidebar and the module list, restorable from the Archived section.
	const modRow = ".sidebar [data-module-id] > a .t";
	const archivedNames = () => page.$$eval(".sidebar .side-row.archived .t", (ts) => ts.map((t) => t.textContent));
	const menu = (name: string, label: string) =>
		page.evaluate(async (n, l) => {
			const row = [...document.querySelectorAll(".sidebar [data-module-id]")].find((r) => r.querySelector("a .t")?.textContent === n);
			(row?.querySelector(".row-menu-btn") as HTMLElement | undefined)?.click();
			await new Promise((r) => setTimeout(r, 150));
			const item = [...document.querySelectorAll(".row-menu [role=menuitem]")].find((b) => b.textContent?.trim().endsWith(l));
			(item as HTMLElement | undefined)?.click();
			await new Promise((r) => setTimeout(r, 150));
		}, name, label);
	await menu("Imported module", "Archive");
	check("Archiving takes a module out of the sidebar", await until("gone from sidebar", async () => !(await page.$$eval(modRow, (ts) => ts.some((t) => t.textContent === "Imported module")))));
	check("…and the Archived section appears, collapsed, with a count", await until("archived section", () => text(".side-archived-toggle").then((t) => /archived/i.test(t) && /1/.test(t))) && (await archivedNames()).length === 0);
	await page.click(".side-archived-toggle");
	check("opening it lists the archived module", await until("archived listed", async () => (await archivedNames()).includes("Imported module")));
	await shot("archived");
	await menu("Imported module", "Restore");
	check("Restore puts it back in the sidebar", await until("restored", async () => (await page.$$eval(modRow, (ts) => ts.some((t) => t.textContent === "Imported module"))) && (await archivedNames()).length === 0));
	check("…and the empty Archived section goes away", !(await page.$(".side-archived-toggle")));
	const after = (await api("GET", `/api/w/${ws}/modules`)).modules.find((m: any) => m.name === "Imported module");
	await api("PATCH", `/api/modules/${after.id}`, { archived: true });
	check("an archived module still opens from its link", await (async () => {
		await go(`#/w/${ws}/modules/${after.id}?focus=1`);
		return !!(await until("opened", () => page.$(".gwin"), 10000));
	})());
	await api("PATCH", `/api/modules/${after.id}`, { archived: false });
	await go(`#/w/${ws}/blueprints`);
	check("restored by the API, it is listed again", await until("back after api restore", () => page.$$eval(modRow, (ts) => ts.some((t) => t.textContent === "Imported module"))));

	await clickText(".bp-head button", "Export…");
	check("export dialog offers my blueprints and the workspace's modules", await until("export dialog", () => text(".tx-dialog").then((t) => /My blueprints \(1\)/.test(t) && /Modules in/.test(t) && /Include their data/.test(t))));
	await sleep(400);
	await shot("export");
	await page.keyboard.press("Escape");

	console.log("workspace home");
	await go(`#/w/${ws}`);
	must("the workspace root is its homepage", await until("home", () => page.$(".home-head")));
	check("it greets you by name", /Welcome/.test(await text(".home-head h1")) && /Ana/.test(await text(".home-head h1")));
	check("a workspace never opened says first time", /first time/i.test(await text(".home-eyebrow")));
	await until("the digest", () => text(".home-away").then((t) => t.includes("Renamed chat")));
	check("what the agent did is in the digest, under its chat", /Renamed chat/.test(await text(".home-away")));
	check("with the run's counts", /run|message/.test(await text(".home-totals")));
	check("the last chat is offered to pick up", /last chat/i.test(await text(".home-grid")));
	await shot("home");
	await clickText(".home-card", /last chat/i);
	check("the card opens that chat", await until("back in the chat", () => page.$(".composer textarea")));
	await page.click(".brand .logo");
	check("the logo returns to the homepage", await until("home again", () => page.$(".home-head")));
	await clickText(".home-actions .btn", /Start a chat/);
	check("Start a chat opens a new chat", await until("new chat", () => page.$(".composer textarea")));

	console.log("mission page");
	const pid = await seedMission(ws);
	const missionHash = (tab: string) => `#/w/${ws}/missions/${pid}?tab=${tab}`;

	await page.evaluate(() => localStorage.setItem("outpost.mission.layout", "side"));
	await go(missionHash("overview"));
	must("mission page renders its tiles", await until("tiles", () => count(".agent-tile").then((n) => n === 4)));
	const sizes = await page.$$eval(".agent-tile", (ts) => ts.map((t) => t.getBoundingClientRect()).map((r) => [Math.round(r.width), Math.round(r.height)]));
	check("side layout: tiles fill their columns (≥180×150)", sizes.every(([w, h]) => w! >= 180 && h! >= 150), sizes);
	check("a developer's tile shows its task", await until("task chip", () => page.$$eval(".at-task", (ts) => ts.some((t) => /T2/.test(t.textContent ?? "")))));
	check("overview has no attachment strip", (await count(".att-strip")) === 0);

	await clickText(".ph-layout button", /Team/);
	await sleep(400);
	check("Team layout: all tiles in one grid above the viewer", (await page.$eval(".mission-body", (b) => b.className)).includes("team") && (await count(".mission-body.team > .tiles .agent-tile")) === 4);
	const sp = await page.$(".splitter");
	if (sp) {
		const box = (await sp.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2, box.y + 150, { steps: 6 });
		await page.mouse.up();
	}
	const split = Number(await page.evaluate(() => localStorage.getItem("outpost.mission.split")));
	check("dragging the splitter resizes and remembers it", sp && split > 0.5 && split <= 0.8, split);
	await page.evaluate(() => localStorage.setItem("outpost.mission.layout", "side"));

	await go(missionHash("requirements"));
	check("Requirements: attachments as a compact strip", await until("chips", () => count(".att-strip .att-chip").then((n) => n === 2)));
	check("Requirements tab label counts the attachments", (await text(".vt-count")).trim() === "2", await text(".vt-count"));
	check("requirements document rendered below", (await text(".doc")).includes("Acceptance"));

	await go(missionHash("repo"));
	must("Repo: the file tree renders", await until("tree", () => count(".rt-row").then((n) => n > 3)));
	const heights = await page.$$eval(".rt-row", (rs) => rs.map((r) => Math.round(r.getBoundingClientRect().height)));
	check("tree rows are full height (not squashed)", heights.every((h) => h >= 24), heights);
	const before = await count(".rt-row");
	const toggleDir = (name: string) => page.evaluate((name) => ([...document.querySelectorAll(".rt-dir")].find((r) => r.querySelector(".rt-name")?.textContent === name) as HTMLElement | undefined)?.click(), name);
	await toggleDir("app/");
	await sleep(200);
	check("a folder collapses", (await count(".rt-row")) < before, { before, after: await count(".rt-row") });
	await toggleDir("app/");
	await sleep(200);
	await clickText(".rt-file", "server.js");
	check("opening a file shows its content", await until("code", () => text(".repo-code").then((t) => t.includes("createServer"))));

	await go(missionHash("backlog"));
	must("Backlog: the build bar shows progress", await until("build bar", () => text(".bl-build").then((t) => /Building/.test(t) && /merged/.test(t))));
	const spill = await page.$$eval(".kb-card", (cards) =>
		cards.flatMap((c) => {
			const box = c.getBoundingClientRect();
			return [...c.querySelectorAll(".kc-pbi, .kc-area, .kc-feature")].filter((e) => e.getBoundingClientRect().right > box.right + 1).map((e) => e.className);
		}),
	);
	check("long card text stays inside its card", spill.length === 0, spill);
	const longCard = await page.$$("xpath/.//button[contains(@class,'kb-card')][.//*[contains(@class,'kc-area') and contains(@class,'over')]]");
	must("long text is detected as overflowing", longCard.length > 0);
	const animBefore = await longCard[0]!.$eval(".kc-area .mq-in", (e) => getComputedStyle(e).animationName);
	await longCard[0]!.hover();
	await sleep(1500);
	const moved = await longCard[0]!.$eval(".kc-area .mq-in", (e) => ({ anim: getComputedStyle(e).animationName, x: new DOMMatrix(getComputedStyle(e).transform).m41 }));
	check("hovering the card scrolls the clipped text", animBefore === "none" && moved.anim === "mq-run" && moved.x < 0, { animBefore, moved });
	await shot("marquee");
	await page.mouse.move(5, 5);
	await clickText(".bl-build button", "Pause build");
	check("pause from the build bar", await until("paused", async () => (await api("GET", `/api/w/${ws}/missions/${pid}`)).backlog.build?.paused === true && /Resume build/.test(await text(".bl-build"))));
	await clickText(".bl-build button", "Resume build");
	await until("resumed", async () => !(await api("GET", `/api/w/${ws}/missions/${pid}`)).backlog.build?.paused);
	await page.evaluate(() => ([...document.querySelectorAll(".kb-card")].find((c) => c.querySelector(".kc-id")?.textContent === "T1") as HTMLElement | undefined)?.click());
	check("a task's panel shows its review and merge history", await until("history", () => text(".ip-history").then((t) => /Changes requested/.test(t) && /Merged into main/.test(t))));
	check("the panel shows the definition of done the reviewer confirmed", (await count(".ip-dod li.met")) === 5 && /confirmed by Reviewer/i.test(await text(".ip")));
	check("the panel shows the checks", /no tests/i.test(await text(".ip-check")));

	await go(missionHash("app"));
	const running = await until("preview running", () => text(".pv-status").then((t) => /Running/.test(t)), 40000);
	check("App tab: the preview runs main", running, await text(".pv"));
	const src = await page.$eval(".pv-frame", (f) => (f as HTMLIFrameElement).src).catch(() => "");
	const body = src ? await fetch(src).then((r) => r.text()).catch(() => "") : "";
	check("the preview iframe serves the app", body.includes("Who's in"), { src, body: body.slice(0, 80) });

	console.log("questions + feedback");
	const pm = (await Workspace.get(ws)).missions;
	const asAgent = async (key: string, name: string, args: unknown) => {
		const a = (await pm.state(pid)).agents[key]!;
		return pm.tools.get(name)!.execute(args, { conversationId: Number(a.conversationId), taskId: Date.now() } as any);
	};
	await asAgent("lead", "ask_user", { question: "Should weekends show?" });
	await asAgent("lead", "ask_user", { question: "Week starts Monday?", blocking: false, assumption: "Monday" });
	await pm.stopAll(pid);
	await go(missionHash("overview"));
	check("readiness: not ready while a blocking question is open", await until("readiness", () => text(".ov-ready.no").then((t) => /Not ready to build/.test(t))));
	check("question cards say blocking / non-blocking, with the assumption", (await count(".q-flag.blocking")) === 1 && (await count(".q-flag.nonblocking")) === 1 && /Monday/.test(await text(".q-assume")));
	await page.evaluate(() => ([...document.querySelectorAll(".q-card.blocking button")].find((b) => b.textContent === "Not blocking") as HTMLElement | undefined)?.click());
	await shot("questions");
	check("switching it to non-blocking makes the mission ready", await until("ready", () => page.$(".ov-ready.yes")));
	const before2 = await count(".q-card");
	await page.evaluate(() => ([...document.querySelectorAll(".q-card button")].find((b) => b.textContent === "Dismiss") as HTMLElement | undefined)?.click());
	check("dismiss closes a question", await until("dismissed", () => count(".q-card").then((n) => n === before2 - 1)));

	await page.evaluate(() => localStorage.setItem("outpost.preview.feedback", "1"));
	await go(missionHash("app"));
	must("App tab: the feedback panel opens", await until("feedback panel", () => page.$(".fb-form textarea")));
	await page.type(".fb-form textarea", "Show the week number in the header");
	await clickText(".fb-form button", "Send to the team");
	check("feedback is listed, tied to the version and with the team", await until("feedback item", () => text(".fb-item").then((t) => /FB-1/.test(t) && /With the team/.test(t) && /@/.test(t))));
	await asAgent("lead", "backlog_add", { items: [{ ref: "p", type: "pbi", parent: "F1", title: "Week number in header", feedback: "FB-1" }, { type: "task", parent: "p", title: "Render the week number", feedback: "FB-1" }] });
	check("drafted items show as waiting for approval", await until("pending status", () => text(".fb-item").then((t) => /Waiting for your approval/.test(t))));
	await shot("feedback");

	await go(missionHash("backlog"));
	must("Backlog: the pending items bar lists them", await until("pending bar", () => text(".bl-pending").then((t) => /2 new items waiting/.test(t) && /FB-1/.test(t))));
	check("pending cards are marked", (await count(".kb-card.pending")) >= 1);
	await shot("pending");
	await clickText(".bl-pending button", /^Approve/);
	check("approve from the bar: nothing pending any more", await until("approved", async () => !Object.values((await api("GET", `/api/w/${ws}/missions/${pid}`)).backlog.items as any[]).some((i) => i.pending)));

	console.log("document gates");
	const { MissionDoc } = await import("../src/missions/docs.ts");
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	await (await Workspace.get(ws)).harness.commit(async (tx: any) => void ((await tx.doc(MissionDoc, pid, null)).gates = {}), BACKGROUND_CONTEXT);
	await asAgent("lead", "request_review", { gate: "requirements", summary: "Three stories, one open point" });
	await pm.stopAll(pid);
	await go(missionHash("overview"));
	check("Overview: the requirements wait for approval", await until("ov gate", () => text(".ov-gate").then((t) => /requirements are waiting for your approval/i.test(t))));
	await go(missionHash("requirements"));
	must("Requirements tab: approval bar", await until("gate bar", () => text(".gate-bar.pending").then((t) => /waiting for your approval/.test(t) && /Three stories/.test(t))));
	await shot("gate");
	await clickText(".gate-bar button", /^Approve requirements/);
	check("approve from the tab", await until("approved", async () => (await api("GET", `/api/w/${ws}/missions/${pid}`)).state.gates?.requirements?.status === "approved" && /approved/.test(await text(".gate-bar"))));
	await go(missionHash("design"));
	check("Design tab: not submitted yet", await until("design gate", () => text(".gate-bar.idle").then((t) => /not submitted for your approval yet/.test(t))));
	await go(missionHash("backlog"));
	check("the backlog says which documents still need approval", /Approve the design first/.test(await text(".bl")) || (await api("GET", `/api/w/${ws}/missions/${pid}`)).backlog.approval.status === "approved");

	console.log("connections");
	process.env.OUTPOST_ALLOW_PRIVATE_HOSTS = "1";
	const { startServices, API_KEY } = await import("./fixtures/services.ts");
	const services = await startServices();
	try {
		await go(`#/w/${ws}/connections`);
		must("Connections page from the sidebar", await until("page", () => text(".page h1").then((t) => t === "Connections")) && /Connections/.test(await text(".side-item.on")));
		await clickText(".page button", "+ Add connection");
		await page.waitForSelector(".conn-form");
		await clickText(".conn-form .gk", /REST API/);
		await page.waitForSelector('.conn-form input[placeholder="https://api.example.com/openapi.json"]');
		await page.type(".conn-form input[pattern]", "inventory");
		await page.type('.conn-form input[placeholder="https://api.example.com/openapi.json"]', `${services.apiOrigin}/openapi.yaml`);
		await page.select(".conn-form select", "header");
		await page.waitForSelector('.conn-form input[placeholder="x-api-key"]');
		await page.type('.conn-form input[placeholder="x-api-key"]', "x-api-key");
		await page.type(".conn-form input[type=password]", API_KEY);
		await clickText(".conn-form button", "Connect");
		check("add a REST API from its OpenAPI document", await until("connected", () => text(".conn").then((t) => /connected/.test(t) && /4 methods/.test(t) && /set ✓/.test(t))), await text(".conn, .conn-form .err"));
		await clickText(".conn .conn-foot button", /4 methods/);
		check("its operations, with reads, writes and destructive ones", await until("methods", async () => (await count(".conn-method")) === 4 && /destructive/.test(await text(".conn-methods"))));

		// Always ask / Always allow, per method.
		const connId = (await api("GET", `/api/w/${ws}/connections`)).connections.find((c: any) => c.label === "inventory").id as string;
		const row = (name: string) => `.conn-method:has(code) >> ::-p-text(${name})`;
		const pressed = (name: string) =>
			page.$$eval(".conn-method", (rows, n) => {
				const r = rows.find((x) => x.querySelector("code")?.textContent === n);
				return [...(r?.querySelectorAll(".seg-btn") ?? [])].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent).join();
			}, name);
		const press = (name: string, label: string) =>
			page.evaluate((n, l) => {
				const r = [...document.querySelectorAll(".conn-method")].find((x) => x.querySelector("code")?.textContent === n);
				([...(r?.querySelectorAll(".seg-btn") ?? [])].find((b) => b.textContent === l) as HTMLElement | undefined)?.click();
			}, name, label);
		void row;
		check("every method has Ask / Allow: reads default to Allow, writes to Ask", (await pressed("listItems")) === "Allow" && (await pressed("createItem")) === "Ask" && (await pressed("deleteItem")) === "Ask");
		check("a card says how many methods ask first", /2 ask first/.test(await text(".conn")));
		await press("createItem", "Allow");
		check("choosing Allow on a write is saved and shown", await until("allow saved", async () => (await pressed("createItem")) === "Allow" && (await api("GET", `/api/w/${ws}/connections`)).connections.find((c: any) => c.id === connId).approval.createItem === "allow"));
		check("a changed method offers a reset to the default", !!(await page.$('.conn-reset[aria-label="Reset createItem to its default"]')));
		await press("deleteItem", "Allow");
		const asked = await until("the confirmation", async () => {
			const dialog = await page.$(".ask-dialog");
			return dialog ? (await text(".ask-dialog")).replace(/\s+/g, " ").trim() : undefined;
		}, 8000);
		check("allowing a destructive method asks you first", /can't easily be undone/.test(asked ?? ""), asked);
		await clickText(".ask-dialog button", "Cancel");
		await sleep(300);
		check("…and Cancel changes nothing", (await pressed("deleteItem")) === "Ask" && !(await api("GET", `/api/w/${ws}/connections`)).connections.find((c: any) => c.id === connId).approval.deleteItem);
		await press("deleteItem", "Allow");
		await until("the confirmation again", () => page.$(".ask-dialog"), 8000);
		await clickText(".ask-dialog button", "Always allow");
		check("…confirming allows it", await until("delete allowed", async () => (await pressed("deleteItem")) === "Allow"));
		await press("listItems", "Ask");
		check("a read can be set to Ask", await until("read asks", async () => (await pressed("listItems")) === "Ask"));
		await shot("connection-approvals");
		for (const m of ["createItem", "deleteItem", "listItems"]) await page.click(`.conn-reset[aria-label="Reset ${m} to its default"]`).then(() => sleep(300));
		check("resetting puts each method back to its default", await until("defaults back", async () => (await pressed("listItems")) === "Allow" && (await pressed("createItem")) === "Ask" && (await pressed("deleteItem")) === "Ask" && !(await page.$("button.conn-reset"))));
		check("…and nothing is left stored", Object.keys((await api("GET", `/api/w/${ws}/connections`)).connections.find((c: any) => c.id === connId).approval).length === 0);
		const listed = await api("GET", `/api/w/${ws}/connections`);
		check("the API never sends the key back", !JSON.stringify(listed).includes(API_KEY));
		await shot("connections");

		await clickText(".side-item .t", "Renamed chat");
		must("back in the chat", await until("resources button", () => clickText(".chat-head button, button", /Resources/)));
		await page.waitForSelector(".gk-grid");
		check("the connection is offered next to the built-in Airlocks", await clickText(".gk", /inventory/));
		must("its methods, to choose from", await until("cap rows", () => count(".cap-row").then((n) => n === 4)));
		check("added in the UI: writes can't be set to auto", !(await page.$$eval(".cap-row select option", (os) => os.some((o) => (o as HTMLOptionElement).value === "auto"))));
		await page.$$eval(".cap-row", (rows) => {
			const row = rows.find((r) => r.textContent?.includes("createItem"));
			const sel = row?.querySelector("select") as HTMLSelectElement | null;
			if (!sel) return;
			sel.value = "deny";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await clickText(".dialog button, .panel button", "Introduce");
		check("introduced: the grant shows its capability", await until("grant card", () => text(".panel").then((t) => /4 of 4 methods/.test(t) && /1 refused/.test(t) && /writes need approval/.test(t))), await text(".panel .err"));
		const { GrantsDoc } = await import("../src/kernel/docs.ts");
		const { BACKGROUND_CONTEXT: bg } = await import("@earendil-works/chord/context");
		const g = Object.values((await (await Workspace.get(ws)).harness.snapshot(GrantsDoc, bg))?.grants ?? {}).find((x) => x.connection);
		check("…stored with the policy", g?.policy?.createItem === "deny" && g?.airlock === "openapi", g);
		await shot("capability");

		await go(`#/w/${ws}/connections`);
		await page.waitForSelector(".conn");
		await clickText(".page button", "+ Add connection");
		await page.waitForSelector(".conn-form");
		await clickText(".conn-form .gk", /Azure DevOps/);
		check("Azure DevOps: organization, project and a personal access token, no auth picker", await until("ado form", async () => {
			const t = await text(".conn-form");
			return /Organization/i.test(t) && /Project/i.test(t) && /Personal access token/i.test(t) && !/Authentication/i.test(t);
		}), await text(".conn-form"));
		await shot("azure-devops-form");
		await clickText(".conn-form button", "Cancel");

		// GitHub: the user supplies a repository and a token; a stand-in api.github.com answers.
		const { createServer } = await import("node:http");
		const gh = createServer((req, res) => {
			const json = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
			if (req.headers.authorization !== "Bearer ghp_ui_test_token_123456") return json(401, { message: "Bad credentials" });
			if (req.url === "/user") return json(200, { login: "build-bot" });
			if (req.url === "/repos/acme/widgets") return json(200, { full_name: "acme/widgets" });
			json(404, { message: "Not Found" });
		});
		await new Promise<void>((r) => gh.listen(0, "127.0.0.1", () => r()));
		process.env.OUTPOST_GITHUB_URL = `http://127.0.0.1:${(gh.address() as any).port}`;
		try {
			await clickText(".page button", "+ Add connection");
			await page.waitForSelector(".conn-form");
			await clickText(".conn-form .gk", /GitHub/);
			check("GitHub: a repository and a personal access token, no auth picker, with how to get the token", await until("github form", async () => {
				const t = await text(".conn-form");
				return /Repository/i.test(t) && /Personal access token/i.test(t) && !/Authentication/i.test(t) && /Fine-grained/i.test(t) && /Contents: Read/i.test(t);
			}), await text(".conn-form"));
			await shot("github-form");
			await page.type('.conn-form input[placeholder="widgets-repo"]', "widgets-gh");
			await page.type('.conn-form input[placeholder="owner/repo"]', "https://github.com/acme/widgets");
			await page.type(".conn-form input[type=password]", "wrong-token");
			await clickText(".conn-form button", "Connect");
			check("a wrong token is explained and nothing half-connects silently", await until("github error", () => text(".conn-form .err").then((t) => /GitHub 401/.test(t) && !t.includes("wrong-token"))), await text(".conn-form .err"));
			await page.$eval(".conn-form input[type=password]", (i) => (i as HTMLInputElement).select());
			await page.type(".conn-form input[type=password]", "ghp_ui_test_token_123456");
			await clickText(".conn-form button", /Save and reconnect|Connect/);
			check("with a good token it connects and shows who it acts as", await until("github connected", () => page.$$eval(".conn", (cs) => cs.some((c) => /widgets-gh/.test(c.textContent ?? "") && /connected/.test(c.textContent ?? "") && /as build-bot/.test(c.textContent ?? "")))));
			check("its card offers Test connection, and lists six methods", await until("github card", () => page.$$eval(".conn", (cs) => cs.some((c) => /Test connection/.test(c.textContent ?? "") && /6 methods/.test(c.textContent ?? "") && /GitHub/.test(c.textContent ?? "")))));
			check("a repository pasted as a URL is shown once, as owner/repo", await page.$$eval(".conn", (cs) => cs.some((c) => /https:\/\/github\.com\/acme\/widgets/.test(c.textContent ?? "") && !/github\.com\/https/.test(c.textContent ?? ""))));
			await shot("github-connected");
			check("the API never returns the token", !JSON.stringify(await api("GET", `/api/w/${ws}/connections`)).includes("ghp_ui_test_token_123456"));
		} finally {
			gh.close();
			delete process.env.OUTPOST_GITHUB_URL;
		}

		const w = await Workspace.get(ws);
		const firstChat = Object.keys((await w.snapshot()).chats.chats)[0]!;
		await go(`#/w/${ws}/connections`);
		await page.waitForSelector(".conn");
		// The agent proposes while the page is open: it must appear live, without a reload.
		const { createOutpostExtension } = await import("../src/agent/extension.ts");
		const { BACKGROUND_CONTEXT: tctx } = await import("@earendil-works/chord/context");
		const proposeTool = createOutpostExtension(w).tools!.find((t: any) => t.name === "propose_connection") as any;
		await proposeTool.execute({ kind: "openapi", label: "stock", title: "Stock API", spec: `${services.apiOrigin}/openapi.yaml`, auth: { kind: "header", name: "x-api-key" }, reason: "Check stock levels for the weekly report", setup: "Inventory admin → API keys" }, { conversationId: Number(firstChat), taskId: 77001 }, tctx);
		check("a proposal shows on the Connections page live, with a badge in the sidebar", await until("proposal", async () => /Proposed by agents/i.test(await text(".conn-proposals")) && /Stock API/.test(await text(".conn-proposals")) && /1/.test(await text(".side-item.on .badge"))));
		await shot("proposal");
		await clickText(".conn-proposal button", "Review and connect");
		must("review: the form is filled in from the proposal", await until("prefilled", () => page.$eval(".conn-form input[pattern]", (i) => (i as HTMLInputElement).value === "stock").catch(() => false)));
		check("…with the agent's reason and how to get the key", /Check stock levels/.test(await text(".conn-form")) && /Inventory admin → API keys/.test(await text(".conn-form")));
		await page.type(".conn-form input[type=password]", API_KEY);
		await clickText(".conn-form button", "Connect");
		check("connected from the proposal", await until("stock connected", () => page.$$eval(".conn", (cs) => cs.some((c) => /Stock API/.test((c as HTMLElement).innerText) && /connected/.test((c as HTMLElement).innerText)))), await text(".conn-form .err"));
		check("the proposal is no longer waiting", await until("gone", async () => !(await page.$(".conn-proposal"))));

		await go(missionHash("overview"));
		must("mission header: Resources", await until("mission resources", () => clickText(".ph-btn", /Resources/)));
		await page.waitForSelector(".gk-grid");
		await clickText(".gk", /inventory/);
		must("mission grants can be for some roles", await until("role chips", () => count(".cap-roles .chip").then((n) => n >= 3)));
		await clickText(".cap-roles .chip", "Developer");
		await clickText(".dialog button, .panel button", "Introduce");
		check("granted to the mission's developers only", await until("mission grant", () => text(".panel").then((t) => /for Developer/.test(t))), await text(".panel .err"));
		const pg = Object.values((await (await Workspace.get(ws)).harness.snapshot(GrantsDoc, bg))?.grants ?? {}).find((x) => x.holder.kind === "mission");
		check("…stored with the role", pg?.holder.id === pid && pg.holder.roles?.join() === "worker", pg?.holder);
		await shot("mission-resources");
	} finally {
		services.close();
	}

	console.log("updates");
	check("no update banner while the server serves the same app", !(await page.$(".update-banner")));
	const { dropSockets } = await import("../src/collab/socket.ts");
	process.env.OUTPOST_BUILD_ID = "a-newer-build";
	dropSockets();
	check("a tab left open across an update offers to reload", await until("banner", () => text(".update-banner").then((t) => /updated while this tab was open/.test(t))));
	delete process.env.OUTPOST_BUILD_ID;

	check("no errors in the page", errors.length === 0, errors);
	console.log("parsed file views");
	// a real docx, uploaded through the same endpoint the browser uses
	const docxB64 = readFileSync(join(import.meta.dirname, "fixtures/files/sample.docx")).toString("base64");
	const docxId = await page.evaluate(
		async (wsId, b64) => {
			const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const res = await fetch(`/api/w/${wsId}/files`, { method: "POST", headers: { "x-file-name": "sample.docx", "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, body: bytes });
			return ((await res.json()) as any).file.id as string;
		},
		ws,
		docxB64,
	);
	await go(`#/w/${ws}/files`);
	await until("the file row", () => page.$(`a[data-nav]`));
	await page.evaluate((name) => {
		const link = [...document.querySelectorAll("a")].find((a) => a.textContent?.includes(name));
		(link as HTMLElement | undefined)?.click();
	}, "sample.docx");
	check("the parsed content renders as HTML", Boolean(await until("parsed html", () => page.$(".parsed-html"))));
	const parsedText = await text(".parsed-html");
	check("the document text is there", parsedText.includes("Outpost ingestion fixture"), parsedText.slice(0, 120));
	check("the table renders in the preview", parsedText.includes("Portal") && Boolean(await page.$(".parsed-html table")));
	check("the embedded image is served by the parse endpoint", Boolean(await page.$(".parsed-html img")));
	check("the summary line names the engine", /document · mammoth/.test(await text(".parsed-head")), await text(".parsed-head"));
	await shot("parsed-docx-content");

	await clickText(".tabs .tab", /Structure/);
	check("the structure tab shows the block model", await until("structure", async () => /"blocks"/.test(await text(".parsed-body"))));
	await shot("parsed-docx-structure");

	await clickText(".tabs .tab", /Design/);
	const designText = await until("design", async () => ((await text(".design")).includes("Theme") ? text(".design") : undefined));
	check("the design tab shows theme, fonts and colours", Boolean(designText) && /Georgia/.test(String(designText)) && /#/.test(String(designText)), String(designText).slice(0, 200));
	check("the design tab lists the style catalogue", /styles \(\d+\)/i.test(String(designText)), String(designText).slice(0, 160));
	await shot("parsed-docx-design");

	await clickText(".parsed-actions button", /Markdown/);
	check("conversion writes a derived file", Boolean(await until("converted", async () => /derived file/i.test(await text(".files-table")), 20000)), await text(".files-table tbody tr"));
	await shot("parsed-converted");

	// keyboard navigation, ported from the Slides module keys
	await page.keyboard.press("Escape");
	await page.waitForSelector(".parsed-html", { hidden: true }).catch(() => undefined);
	await page.keyboard.press("ArrowDown");
	const firstCursor = await page.evaluate(() => document.querySelector(".nav-on")?.textContent?.slice(0, 40) ?? "");
	check("ArrowDown highlights a navigation item", Boolean(firstCursor), firstCursor);
	await page.keyboard.press("ArrowDown");
	const secondCursor = await page.evaluate(() => document.querySelector(".nav-on")?.textContent?.slice(0, 40) ?? "");
	check("ArrowDown moves the cursor", secondCursor !== firstCursor, `${firstCursor} → ${secondCursor}`);
	await page.keyboard.press("ArrowUp");
	check("ArrowUp moves it back", (await page.evaluate(() => document.querySelector(".nav-on")?.textContent?.slice(0, 40) ?? "")) === firstCursor);
	check("only one item is highlighted at a time", (await page.evaluate(() => document.querySelectorAll(".nav-on").length)) === 1);
	await shot("keyboard-cursor");
	// never hijack typing
	await page.evaluate(() => {
		const input = document.querySelector("input.input") as HTMLInputElement | undefined;
		input?.focus();
	});
	const typingCursor = await page.evaluate(() => document.querySelector(".nav-on")?.textContent?.slice(0, 40) ?? "");
	await page.keyboard.press("ArrowDown");
	check("arrows are not captured while typing", (await page.evaluate(() => document.querySelector(".nav-on")?.textContent?.slice(0, 40) ?? "")) === typingCursor);
	await page.keyboard.press("Escape");
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	console.log("ask agent from files");
	await go(`#/w/${ws}/files`);
	await until("the files table", () => page.$(".files-table tbody tr"));
	const askClicked = await page.evaluate(() => {
		const rows = [...document.querySelectorAll(".files-table tbody tr")];
		const row = rows.find((r) => r.textContent?.includes("sample.docx"));
		const button = [...(row?.querySelectorAll("button") ?? [])].find((b) => /Ask agent/.test(b.textContent ?? ""));
		button?.click();
		return Boolean(button);
	});
	check("the row has an Ask agent button", askClicked);
	const askChatUrl = await until("a chat URL", async () => (/^https?:.+\/w\/[^/]+\/c\/\d+/.test(page.url()) ? page.url() : undefined), 20000);
	check("Ask agent opens a real chat, not the homepage", Boolean(askChatUrl), page.url());
	const askAttached = await until("the attachment tray", async () => {
		const name = await page.evaluate(() => document.querySelector(".attachments .attachment .n")?.textContent ?? "");
		return name || undefined;
	}, 20000);
	check("the file is attached in that chat", askAttached === "sample.docx", askAttached ?? (await text(".attachments")));
	check("the composer is ready to send it", Boolean(await page.$(".composer textarea, .composer input")));
	await shot("ask-agent-attached");

	console.log("artifacts in chat");
	const upload = (wsId: string, name: string, mime: string, body: string) =>
		page.evaluate(
			async (wsId, name, mime, body) => {
				const r = await fetch(`/api/w/${wsId}/files`, { method: "POST", headers: { "x-file-name": encodeURIComponent(name), "content-type": mime }, body });
				const json = await r.json();
				if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(json)}`);
				return (json as { file: { id: string } }).file.id;
			},
			wsId,
			name,
			mime,
			body,
		);
	const csvId = await upload(ws, "revenue.csv", "text/csv", "region,revenue,when\nEMEA,120,2026-01-04\nAPAC,60,2026-02-11\nAMER,300,2026-03-02\n");
	const jsonId = await upload(ws, "data.json", "application/json", '{"team":{"name":"Outpost"},"items":[{"name":"alpha","score":30},{"name":"beta","score":10}]}');
	const mdId = await upload(ws, "plan.md", "text/markdown", "# Ship plan\n\n## Steps\n\n- [ ] write the parser\n- [x] wire the view\n");
	const htmlId = await upload(ws, "demo.html", "text/html", '<html><body><h1>Interactive</h1><button id="b">Count</button><span id="n">0</span><script>let n=0;document.getElementById("b").onclick=function(){n++;document.getElementById("n").textContent=String(n)}</script></body></html>');
	// The chat the Ask-agent button opened: pin it to the offline demo so this stays hermetic.
	const chatId = /\/c\/(\d+)/.exec(page.url())?.[1];
	if (chatId) await api("PATCH", `/api/w/${ws}/chats/${chatId}`, { model: { provider: "outpost-demo", modelId: "demo" } });
	const ask = async (id: string) => {
		await page.click(".composer textarea");
		await page.type(".composer textarea", `show me ${id}`);
		await page.keyboard.press("Enter");
		await until(`the card for ${id}`, () => page.$(`.artifact[data-artifact="${id}"]`), 30000);
	};

	await ask(csvId);
	await until("the table", () => page.$(`.artifact[data-artifact="${csvId}"] .art-table tbody tr`), 20000);
	check("a csv embedded in a reply renders as a table", (await count(`.artifact[data-artifact="${csvId}"] .art-table tbody tr`)) === 3);
	const header = await page.$$eval(`.artifact[data-artifact="${csvId}"] .art-table thead th`, (ths) => ths.map((t) => (t as HTMLElement).innerText.trim()));
	check("the header row is the table's columns", header.join("|").includes("revenue") && header.join("|").includes("when"), header);
	const firstRevenue = () => page.$eval(`.artifact[data-artifact="${csvId}"] .art-table tbody tr td:nth-child(3)`, (td) => (td as HTMLElement).innerText.trim());
	await page.$$eval(`.artifact[data-artifact="${csvId}"] .art-table thead th`, (ths) => (ths[2] as HTMLElement).click());
	check("clicking a column header sorts it", (await firstRevenue()) === "60", await firstRevenue());
	await page.type(`.artifact[data-artifact="${csvId}"] .art-filter`, "apac");
	check("the filter box narrows the rows", (await count(`.artifact[data-artifact="${csvId}"] .art-table tbody tr`)) === 1);
	await page.click(`.artifact[data-artifact="${csvId}"] .art-filter`);
	await page.keyboard.down("Control");
	await page.keyboard.press("KeyA");
	await page.keyboard.up("Control");
	await page.keyboard.press("Backspace");
	await page.evaluate((id) => {
		const root = document.querySelector(`.artifact[data-artifact="${id}"]`);
		[...(root?.querySelectorAll("button") ?? [])].find((b) => /Chart/.test(b.innerText))?.click();
	}, csvId);
	await until("the chart", () => page.$(`.artifact[data-artifact="${csvId}"] .art-svg rect`), 10000);
	check("the chart draws a bar per row", (await count(`.artifact[data-artifact="${csvId}"] .art-svg rect`)) === 3);
	await shot("artifact-table");

	await ask(jsonId);
	await until("the json tree", () => page.$(`.artifact[data-artifact="${jsonId}"] .jn-row`), 20000);
	check("json opens as a tree", (await count(`.artifact[data-artifact="${jsonId}"] .jn-row`)) > 2);
	await page.type(`.artifact[data-artifact="${jsonId}"] .art-query`, ".items[].name");
	const counted = await until("the query result", async () => {
		const t = await text(`.artifact[data-artifact="${jsonId}"] .art-count`);
		return /2 results/.test(t) ? t : undefined;
	}, 10000);
	check("the query box runs jq-lite", Boolean(counted), counted);
	check("the query result renders as values", (await text(`.artifact[data-artifact="${jsonId}"] .art-tree`)).includes("alpha"));
	await page.type(`.artifact[data-artifact="${jsonId}"] .art-query`, " | flip()");
	check("a bad query explains itself", Boolean(await until("the query error", async () => ((await text(`.artifact[data-artifact="${jsonId}"] .art-count.bad`)) ? true : undefined), 8000)));
	await shot("artifact-json");

	await ask(mdId);
	await until("the markdown", () => page.$(`.artifact[data-artifact="${mdId}"] .art-doc input[type=checkbox]`), 20000);
	check("markdown renders with a contents list", (await count(`.artifact[data-artifact="${mdId}"] .art-toc-item`)) === 2);
	check("task checkboxes are live, not disabled", !(await page.$eval(`.artifact[data-artifact="${mdId}"] .art-doc input[type=checkbox]`, (i) => (i as HTMLInputElement).disabled)));
	await page.click(`.artifact[data-artifact="${mdId}"] .art-doc input[type=checkbox]`);
	const saved = await until("the file to be written back", async () => {
		const r = await api("GET", `/api/w/${ws}/files/${mdId}/parsed?view=json`);
		return /- \[x\] write the parser/.test(r.parsed?.text ?? "") ? r.parsed.text : undefined;
	}, 15000);
	check("ticking a checkbox writes the file", Boolean(saved), saved?.slice(0, 80));
	await shot("artifact-markdown");

	// Diagrams: a .mmd file is drawn, and a ```mermaid fence in a reply is drawn in place.
	const mmdId = await upload(ws, "flow.mmd", "text/plain", "flowchart LR\n  order --> payment\n  payment --> shipped\n");
	await ask(mmdId);
	await until("the diagram", () => page.$(`.artifact[data-artifact="${mmdId}"] .diagram svg`), 30000);
	check("a .mmd file draws as a diagram instead of printing its source", (await count(`.artifact[data-artifact="${mmdId}"] .diagram svg path`)) >= 2);
	check("the card names what kind of diagram it is", (await text(`.artifact[data-artifact="${mmdId}"] .diagram-kind`)) === "flowchart", await text(`.artifact[data-artifact="${mmdId}"] .diagram-kind`));
	check("the source stays hidden until asked for", await page.$eval(`.artifact[data-artifact="${mmdId}"] .diagram-src`, (e) => (e as HTMLElement).hidden));
	await page.click(`.artifact[data-artifact="${mmdId}"] .diagram-btn`);
	check("Source reveals the Mermaid text", (await text(`.artifact[data-artifact="${mmdId}"] .diagram-src`)).includes("payment --> shipped"));
	await page.click(`.artifact[data-artifact="${mmdId}"] .diagram-btn`);
	await shot("artifact-diagram");

	await page.click(".composer textarea");
	await page.type(".composer textarea", "draw a diagram of a request going through the app");
	await page.keyboard.press("Enter");
	await until("a diagram in the reply", () => page.$(".msg-assistant .diagram svg"), 30000);
	check("a mermaid fence in a reply is drawn, not printed", (await count(".msg-assistant .diagram svg")) >= 1);
	check("the diagram keeps its place in the markdown, with the code block hidden", await page.$$eval(".msg-assistant pre", (pres) => pres.some((p) => (p as HTMLElement).hidden && /flowchart/.test(p.textContent ?? ""))));
	await shot("chat-diagram");

	// A tool call says which module and blueprint it touched, not their ids.
	await page.click(".composer textarea");
	await page.type(".composer textarea", "make a todo list for the offsite");
	await page.keyboard.press("Enter");
	const createRow = await until(
		"the module_create call",
		async () => (await page.$$eval(".msg-assistant .proc", (rows) => rows.map((r) => r.textContent ?? ""))).find((t) => /module_create/.test(t)),
		30000,
	);
	check("the tool row names the module it made", /Todo/.test(createRow ?? ""), createRow);
	check("…and its blueprint by name", /from the .* blueprint/.test(createRow ?? ""), createRow);
	check("…never by id", !/(bp|g|mod)_[0-9a-z]{6,}/.test(createRow ?? ""), createRow);
	await shot("tool-names");

	await ask(htmlId);
	await until("the frame", () => page.$(`.artifact[data-artifact="${htmlId}"] iframe`), 20000);
	const sandbox = await page.$eval(`.artifact[data-artifact="${htmlId}"] iframe`, (f) => f.getAttribute("sandbox") ?? "");
	check("html runs sandboxed without same-origin", sandbox.includes("allow-scripts") && !sandbox.includes("allow-same-origin"), sandbox);
	const frame = await until("the frame's document", async () => {
		const found = page.frames().find((f) => f.url() === "about:srcdoc");
		return found ?? undefined;
	}, 15000);
	const clicked = await frame!.evaluate(() => {
		const button = document.getElementById("b") as HTMLButtonElement | null;
		if (!button) return "no button";
		button.click();
		button.click();
		return (document.getElementById("n") as HTMLElement | null)?.textContent ?? "no counter";
	});
	check("scripts inside the artifact run", clicked === "2", clicked);
	const blocked = await frame!.evaluate(async () => {
		try {
			await fetch("http://127.0.0.1:9/", { mode: "no-cors" });
			return "reached the network";
		} catch (e) {
			return (e as Error).message;
		}
	});
	check("the artifact cannot reach the network", blocked !== "reached the network", blocked);
	check("the frame reports its height back to the card", (await page.$eval(`.artifact[data-artifact="${htmlId}"] iframe`, (f) => Number((f as HTMLElement).style.height.replace("px", "")))) > 20);
	await shot("artifact-html");
	await archivedChatsAndDialogs(ws);

}


/** A mission mid-build: requirements, two attachments, T1 reviewed (changes, then approved) and merged, T2 in progress, preview config on main. */
async function seedMission(wsId: string): Promise<string> {
	const ws = await Workspace.get(wsId);
	const pm = ws.missions;
	pm.build.nudges = false;
	const ana = users.byUsername("ana")!;
	const { mission } = await api("POST", `/api/w/${wsId}/missions`, { goal: "A team availability board: who is in the office which day", model: { provider: "outpost-demo", modelId: "demo" } });
	const pid = mission.id as string;
	await passDocGates(ws, pid);
	await pm.stopAll(pid);
	for (const role of ["worker", "worker", "reviewer"]) await pm.addAgent(pid, { role, brief: "wait", start: false });
	const repo = pm.repo(pid);
	await repo.writeMain("docs/requirements.md", "# Requirements\n\n## Acceptance\n- Mon–Fri columns\n", "requirements");
	// two attachments, through the same API the page uses
	const up = (name: string, body: string, type: string) => page.evaluate(async (wsId, name, body, type) => (await (await fetch(`/api/w/${wsId}/files`, { method: "POST", headers: { "x-file-name": name, "content-type": type }, body })).json()).file.id, wsId, name, body, type);
	const files = [await up("brief.txt", "office days matter", "text/plain"), await up("roster.csv", "name\nAna\nBo", "text/csv")];
	await api("POST", `/api/w/${wsId}/missions/${pid}/agents/lead/messages`, { text: "for the requirements", files });
	await pm.stopAll(pid);

	await pm.editBacklog(pid, (b) =>
		addItems(
			b,
			[
				{ ref: "f", type: "feature", title: "Weekly board" },
				{ ref: "p", type: "pbi", parent: "f", title: "See who's in: [Must] simulation core with the state and action contract, fixed step and seeded PRNG (design §4/§6/§7)", acceptance: ["Mon–Fri columns"] },
				{ ref: "t1", type: "task", parent: "p", title: "Serve the board page", area: "app/server" },
				{ type: "task", parent: "p", title: "Render the week grid", deps: ["t1"], area: "app/index.html, app/styles, app/src/ui, app/src/main.js" },
			],
			"planner",
		),
	);
	await pm.approveBacklog(pid, ana);
	const item = async (id: string) => (await pm.backlog(pid)).items[id]!;
	const agent = async (k: string) => (await pm.state(pid)).agents[k]!;
	await until("T1 briefed", async () => (await item("T1")).briefed);
	const write = (path: string, c: string) => {
		const f = join(repo.worktree("dev-1"), path);
		mkdirSync(join(f, ".."), { recursive: true });
		writeFileSync(f, c);
	};
	write("app/server.js", `require("http").createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<h1>Who's in this week</h1>"); }).listen(process.env.PORT, "127.0.0.1");\n`);
	write("app/package.json", `{ "name": "whos-in", "private": true }\n`);
	write(".outpost/mission.json", JSON.stringify({ dev: { command: "node server.js", readyPath: "/" } }));
	await pm.build.taskDone(pid, await agent("dev-1"), "board page", false);
	await until("review 1", async () => (await item("T1")).reviewBriefed && (await item("T1")).reviewer === "reviewer");
	await pm.build.verdict(pid, await agent("reviewer"), "T1", "changes", "Set the content type");
	await pm.build.taskDone(pid, await agent("dev-1"), "content type set", false);
	await until("review 2", async () => (await item("T1")).reviewBriefed && (await item("T1")).reviewRound === 2);
	await pm.build.verdict(pid, await agent("reviewer"), "T1", "approve", "ok", DEFAULT_DOD.map((_, i) => ({ item: i + 1, met: true })));
	await until("T2 briefed", async () => (await item("T2")).briefed);
	return pid;
}

/** Archived chats under Archived, restore, and the in-app dialogs: run last, they change what the sidebar shows. */
async function archivedChatsAndDialogs(ws: string) {
	// Archived chats belong in the Archived section and come back on Restore (they used to vanish).
	console.log("archived chats");
	await go(`#/w/${ws}`);
	const liveRows = () => page.$$eval(".sidebar [data-chat-id]:not(.archived) a .t", (ts) => ts.map((t) => t.textContent ?? ""));
	const archivedRows = () => page.$$eval(".sidebar .side-row.archived a .t", (ts) => ts.map((t) => t.textContent ?? ""));
	const victim = await until("a chat in the sidebar", async () => {
		const names = await liveRows();
		return names.length ? names[0] : undefined;
	});
	const victimId = await page.$eval(".sidebar [data-chat-id]:not(.archived)", (row) => row.getAttribute("data-chat-id") ?? "");
	must("found a chat to archive", Boolean(victim) && Boolean(victimId));
	await api("PATCH", `/api/w/${ws}/chats/${victimId}`, { archived: true });
	check("an archived chat leaves the live sidebar list", await until("chat gone", async () => !(await liveRows()).includes(victim!), 10000));
	const shown = await until("the archived section", async () => {
		const toggle = await page.$(".side-archived-toggle");
		if (!toggle) return undefined;
		const expanded = await page.$eval(".side-archived-toggle", (b) => b.getAttribute("aria-expanded") === "true");
		if (!expanded) await page.click(".side-archived-toggle");
		const names = await archivedRows();
		return names.includes(victim!) ? names : undefined;
	}, 10000);
	check("…and it is listed under Archived", Boolean(shown), await archivedRows());
	await shot("archived-chat");
	await page.evaluate((id) => {
		const row = document.querySelector(`.sidebar [data-chat-id="${id}"]`);
		(row?.querySelector(".row-menu-btn") as HTMLElement | undefined)?.click();
	}, victimId);
	await sleep(200);
	await clickText(".row-menu [role=menuitem]", /^▣?\s*Restore|Restore/);
	check("Restore puts the chat back in the sidebar", await until("chat back", async () => (await liveRows()).includes(victim!), 10000), await liveRows());
	check("…and Archived no longer lists it", await until("archived gone", async () => !(await archivedRows()).includes(victim!), 10000), await archivedRows());

	console.log("in-app dialogs");
	await go(`#/w/${ws}/files`);
	await until("the files table", () => page.$(".files-table tbody tr"));
	const doomed = await until("a file row", () => page.$$eval(".files-table tbody tr .fname a", (links) => links.map((a) => (a as HTMLElement).innerText.trim()).find((t) => t.length > 0)));
	check("there is a file to delete", Boolean(doomed), await page.$$eval(".files-table tbody tr .fname a", (links) => links.map((a) => (a as HTMLElement).innerText.trim())));
	const deleteRow = async (name: string) =>
		page.evaluate((name) => {
			const row = [...document.querySelectorAll(".files-table tbody tr")].find((r) => ((r.querySelector(".fname") as HTMLElement | null)?.innerText ?? "").includes(name));
			[...(row?.querySelectorAll("button") ?? [])].find((b) => (b.getAttribute("title") ?? "") === "Delete")?.click();
		}, name);
	await deleteRow(doomed!);
	const confirmBody = await until("the delete dialog", async () => {
		const dialog = await page.$(".ask-dialog");
		return dialog ? (await text(".ask-dialog")).replace(/\s+/g, " ").trim() : undefined;
	}, 8000);
	check("deleting a file asks in an in-app dialog", Boolean(confirmBody) && confirmBody!.includes(doomed!.slice(0, 12)), confirmBody);
	check("…and nothing is deleted until you confirm", (await count(".files-table tbody tr")) > 0);
	await page.keyboard.press("Escape");
	check("Escape cancels the dialog", await until("dialog gone", async () => !(await page.$(".ask-dialog")), 5000));
	check("…and the file is still there", (await page.evaluate((name) => [...document.querySelectorAll(".files-table tbody tr")].some((r) => ((r.querySelector(".fname") as HTMLElement | null)?.innerText ?? "").includes(name)), doomed!)) === true);
	await deleteRow(doomed!);
	await until("the delete dialog again", () => page.$(".ask-dialog"), 8000);
	await clickText(".ask-dialog button", "Delete");
	check("confirming deletes it", await until("row gone", async () => !(await page.evaluate((name) => [...document.querySelectorAll(".files-table tbody tr")].some((r) => ((r.querySelector(".fname") as HTMLElement | null)?.innerText ?? "").includes(name)), doomed!)), 15000));
	await shot("dialog-confirm");

	// The text dialog: a workspace name, required, cancellable.
	await page.select(".ws-switch select", "__new");
	const named = await until("the name dialog", async () => {
		const dialog = await page.$(".ask-dialog input.ask-input");
		return dialog ? true : undefined;
	}, 8000);
	check("a new workspace asks for a name in-app", Boolean(named));
	if (named) {
		const disabled = await page.$eval(".ask-dialog button[type=submit]", (b) => (b as HTMLButtonElement).disabled);
		check("the create button waits for a name", disabled === true);
		await page.type(".ask-dialog input.ask-input", "Second workspace");
		await page.keyboard.press("Enter");
		check("Enter submits the dialog", await until("workspace created", async () => /Second workspace/.test(await text(".ws-switch")), 15000), await text(".ws-switch"));
		await go(`#/w/${ws}/files`);
	}
}

// ------------------------------------------------------------------ main

const browser = await puppeteer.launch({ executablePath: browserPath, headless: !process.env.HEADFUL, timeout: 90_000, defaultViewport: { width: 1600, height: 1000 }, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors: string[] = [];
try {
	page = await browser.newPage();
	page.on("pageerror", (e) => errors.push(String((e as Error).message ?? e)));
	page.on("console", (m) => m.type() === "error" && !/Failed to load resource|ERR_CONNECTION_REFUSED|WebSocket/.test(m.text()) && errors.push(m.text()));
	await run();
} catch (e) {
	await browser.close().catch(() => {});
	await finish(e);

	// ------------------------------------------------------------------ artifacts in chat
}
await browser.close().catch(() => {});
await finish();
