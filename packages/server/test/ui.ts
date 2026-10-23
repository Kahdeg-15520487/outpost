/**
 * Browser test of the web app against a real (in-process) pi-os: chat, sidebar menus, the model
 * picker, and the project page (layouts, tiles, attachments, repo tree, backlog build bar, item
 * history, live preview). Needs Chrome, Edge or Chromium (or PI_OS_CHROME) and a built web app
 * (pnpm build). Run: pnpm --filter @pi-os/server test:ui   (HEADFUL=1 to watch)
 */
import { check, finish, must, sleep, startServer, until } from "./lib/harness.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";

const { config } = await import("../src/config.ts");
const { findBrowser } = await import("../src/gadgets/render.ts");
const browserPath = findBrowser();
if (!browserPath) {
	console.log("  - skipped: no Chrome/Edge/Chromium found (set PI_OS_CHROME)");
	await finish();
}
if (!existsSync(join(config.webDist, "index.html"))) await finish(new Error("The web app isn't built: run `pnpm build` first"));

const base = await startServer();
const { Workspace } = await import("../src/kernel/workspace.ts");
const { users } = await import("../src/kernel/system-db.ts");
const { addItems } = await import("../src/projects/backlog.ts");

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
	await api("POST", "/api/auth/signup", { username: "ana", password: "password123", displayName: "Ana" });
	const ws = (await api("GET", "/api/workspaces")).workspaces[0].id as string;
	await go("");
	must("signed in: the shell shows the sidebar", await until("sidebar", () => page.$(".new-chat")));

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

	console.log("model picker");
	// A second provider (never called) so the picker has something to hide. Set only now: the chat above
	// must keep the demo model as its default.
	process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
	await page.reload();
	await page.waitForSelector(".composer select");
	// (1-based so a first-position select isn't falsy)
	const found = await until("model select", () => page.$$eval(".composer select", (ss) => ss.findIndex((s) => [...(s as HTMLSelectElement).options].some((o) => o.value === "__manage")) + 1));
	must("the chat has a model dropdown", typeof found === "number" && found > 0);
	const selectWithManage = found - 1;
	await page.$$eval(".composer select", (ss, i) => {
		const s = ss[i] as HTMLSelectElement;
		s.value = "__manage";
		s.dispatchEvent(new Event("change", { bubbles: true }));
	}, selectWithManage);
	must("Choose models… opens the picker", await until("picker", () => page.$(".mp-dialog")));
	await page.type(".mp-dialog input.input", "demo");
	await clickText(".mp-dialog button", /Uncheck all|Uncheck matches/);
	await page.$eval(".mp-dialog input.input", (i) => {
		const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		set.call(i, "");
		i.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await clickText(".mp-dialog button", "Uncheck all");
	await page.type(".mp-dialog input.input", "demo");
	await clickText(".mp-dialog button", "Check matches");
	await clickText(".mp-dialog button", "Save");
	await until("dialog closed", async () => !(await page.$(".mp-dialog")));
	const picker = (await api("GET", "/api/models")).picker;
	// A fully checked provider is stored as "everything" (omitted); hidden ones as [].
	check("picker saved per user: OpenAI hidden, demo kept", Array.isArray(picker.openai) && picker.openai.length === 0 && (picker["pi-os-demo"] === undefined || JSON.stringify(picker["pi-os-demo"]) === '["demo"]'), picker);
	const options = await page.$$eval(".composer select option", (os) => (os as HTMLOptionElement[]).filter((o) => !o.disabled).map((o) => o.value).filter((v) => v && v !== "__manage"));
	check("the dropdown offers only the picked models", options.length > 0 && options.every((v) => v.startsWith("pi-os-demo/")), options);

	console.log("export / import");
	const bundlePath = join(process.env.PI_OS_DATA!, "..", "import.pios.json");
	writeFileSync(
		bundlePath,
		JSON.stringify({ format: "pi-os/bundle", version: 1, exportedAt: new Date().toISOString(), blueprints: [{ name: "Imported board", description: "from elsewhere", icon: "▦", files: { "index.html": "<h1>board</h1>" } }], gadgets: [{ name: "Imported gadget", icon: "◆", files: { "index.html": "<h1>hi</h1>" }, data: { count: 3 } }] }),
	);
	await go(`#/w/${ws}/blueprints`);
	must("Blueprints page has Import and Export", await until("buttons", () => page.$$eval(".bp-head button", (bs) => bs.map((b) => b.textContent).join()).then((t) => /Import/.test(t) && /Export/.test(t))));
	await clickText(".bp-head button", "Import…");
	const fileInput = await until("file input", () => page.$(".tx-drop input[type=file]"));
	await (fileInput as any).uploadFile(bundlePath);
	check("import shows what the file holds before importing", await until("preview", () => text(".tx-preview").then((t) => /Imported board/.test(t) && /Imported gadget/.test(t) && /with data/.test(t))));
	await shot("import");
	await clickText(".tx-dialog button", "Import");
	check("import result lists the new blueprint and gadget", await until("result", () => text(".tx-dialog").then((t) => /imported/i.test(t) && /in your library/i.test(t) && /Imported gadget/.test(t))));
	await clickText(".tx-dialog button", "Done");
	check("the imported blueprint is in the library", await until("listed", () => page.$$eval(".bp-grid .bp .n", (ns) => ns.some((n) => n.textContent === "Imported board"))));
	check("the imported gadget is in the sidebar", await until("sidebar gadget", () => page.$$eval(".side-item .t", (ts) => ts.some((t) => t.textContent === "Imported gadget"))));
	await clickText(".bp-head button", "Export…");
	check("export dialog offers my blueprints and the workspace's gadgets", await until("export dialog", () => text(".tx-dialog").then((t) => /My blueprints \(1\)/.test(t) && /Gadgets in/.test(t) && /Include their data/.test(t))));
	await sleep(400);
	await shot("export");
	await page.keyboard.press("Escape");

	console.log("project page");
	const pid = await seedProject(ws);
	const projectHash = (tab: string) => `#/w/${ws}/p/${pid}?tab=${tab}`;

	await page.evaluate(() => localStorage.setItem("pios.project.layout", "side"));
	await go(projectHash("overview"));
	must("project page renders its tiles", await until("tiles", () => count(".agent-tile").then((n) => n === 4)));
	const sizes = await page.$$eval(".agent-tile", (ts) => ts.map((t) => t.getBoundingClientRect()).map((r) => [Math.round(r.width), Math.round(r.height)]));
	check("side layout: tiles fill their columns (≥180×150)", sizes.every(([w, h]) => w! >= 180 && h! >= 150), sizes);
	check("a developer's tile shows its task", await until("task chip", () => page.$$eval(".at-task", (ts) => ts.some((t) => /T2/.test(t.textContent ?? "")))));
	check("overview has no attachment strip", (await count(".att-strip")) === 0);

	await clickText(".ph-layout button", /Team/);
	await sleep(400);
	check("Team layout: all tiles in one grid above the viewer", (await page.$eval(".project-body", (b) => b.className)).includes("team") && (await count(".project-body.team > .tiles .agent-tile")) === 4);
	const sp = await page.$(".splitter");
	if (sp) {
		const box = (await sp.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2, box.y + 150, { steps: 6 });
		await page.mouse.up();
	}
	const split = Number(await page.evaluate(() => localStorage.getItem("pios.project.split")));
	check("dragging the splitter resizes and remembers it", sp && split > 0.5 && split <= 0.8, split);
	await page.evaluate(() => localStorage.setItem("pios.project.layout", "side"));

	await go(projectHash("requirements"));
	check("Requirements: attachments as a compact strip", await until("chips", () => count(".att-strip .att-chip").then((n) => n === 2)));
	check("Requirements tab label counts the attachments", (await text(".vt-count")).trim() === "2", await text(".vt-count"));
	check("requirements document rendered below", (await text(".doc")).includes("Acceptance"));

	await go(projectHash("repo"));
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

	await go(projectHash("backlog"));
	must("Backlog: the build bar shows progress", await until("build bar", () => text(".bl-build").then((t) => /Building/.test(t) && /merged/.test(t))));
	await clickText(".bl-build button", "Pause build");
	check("pause from the build bar", await until("paused", async () => (await api("GET", `/api/w/${ws}/projects/${pid}`)).backlog.build?.paused === true && /Resume build/.test(await text(".bl-build"))));
	await clickText(".bl-build button", "Resume build");
	await until("resumed", async () => !(await api("GET", `/api/w/${ws}/projects/${pid}`)).backlog.build?.paused);
	await page.evaluate(() => ([...document.querySelectorAll(".kb-card")].find((c) => c.querySelector(".kc-id")?.textContent === "T1") as HTMLElement | undefined)?.click());
	check("a task's panel shows its review and merge history", await until("history", () => text(".ip-history").then((t) => /Changes requested/.test(t) && /Merged into main/.test(t))));

	await go(projectHash("app"));
	const running = await until("preview running", () => text(".pv-status").then((t) => /Running/.test(t)), 40000);
	check("App tab: the preview runs main", running, await text(".pv"));
	const src = await page.$eval(".pv-frame", (f) => (f as HTMLIFrameElement).src).catch(() => "");
	const body = src ? await fetch(src).then((r) => r.text()).catch(() => "") : "";
	check("the preview iframe serves the app", body.includes("Who's in"), { src, body: body.slice(0, 80) });

	console.log("questions + feedback");
	const pm = (await Workspace.get(ws)).projects;
	const asAgent = async (key: string, name: string, args: unknown) => {
		const a = (await pm.state(pid)).agents[key]!;
		return pm.tools.get(name)!.execute(args, { conversationId: Number(a.conversationId), taskId: Date.now() } as any);
	};
	await asAgent("lead", "ask_user", { question: "Should weekends show?" });
	await asAgent("lead", "ask_user", { question: "Week starts Monday?", blocking: false, assumption: "Monday" });
	await pm.stopAll(pid);
	await go(projectHash("overview"));
	check("readiness: not ready while a blocking question is open", await until("readiness", () => text(".ov-ready.no").then((t) => /Not ready to build/.test(t))));
	check("question cards say blocking / non-blocking, with the assumption", (await count(".q-flag.blocking")) === 1 && (await count(".q-flag.nonblocking")) === 1 && /Monday/.test(await text(".q-assume")));
	await page.evaluate(() => ([...document.querySelectorAll(".q-card.blocking button")].find((b) => b.textContent === "Not blocking") as HTMLElement | undefined)?.click());
	await shot("questions");
	check("switching it to non-blocking makes the project ready", await until("ready", () => page.$(".ov-ready.yes")));
	const before2 = await count(".q-card");
	await page.evaluate(() => ([...document.querySelectorAll(".q-card button")].find((b) => b.textContent === "Dismiss") as HTMLElement | undefined)?.click());
	check("dismiss closes a question", await until("dismissed", () => count(".q-card").then((n) => n === before2 - 1)));

	await page.evaluate(() => localStorage.setItem("pios.preview.feedback", "1"));
	await go(projectHash("app"));
	must("App tab: the feedback panel opens", await until("feedback panel", () => page.$(".fb-form textarea")));
	await page.type(".fb-form textarea", "Show the week number in the header");
	await clickText(".fb-form button", "Send to the team");
	check("feedback is listed, tied to the version and with the team", await until("feedback item", () => text(".fb-item").then((t) => /FB-1/.test(t) && /With the team/.test(t) && /@/.test(t))));
	await asAgent("lead", "backlog_add", { items: [{ ref: "p", type: "pbi", parent: "F1", title: "Week number in header", feedback: "FB-1" }, { type: "task", parent: "p", title: "Render the week number", feedback: "FB-1" }] });
	check("drafted items show as waiting for approval", await until("pending status", () => text(".fb-item").then((t) => /Waiting for your approval/.test(t))));
	await shot("feedback");

	await go(projectHash("backlog"));
	must("Backlog: the pending items bar lists them", await until("pending bar", () => text(".bl-pending").then((t) => /2 new items waiting/.test(t) && /FB-1/.test(t))));
	check("pending cards are marked", (await count(".kb-card.pending")) >= 1);
	await shot("pending");
	await clickText(".bl-pending button", /^Approve/);
	check("approve from the bar: nothing pending any more", await until("approved", async () => !Object.values((await api("GET", `/api/w/${ws}/projects/${pid}`)).backlog.items as any[]).some((i) => i.pending)));

	check("no errors in the page", errors.length === 0, errors);
}

/** A project mid-build: requirements, two attachments, T1 reviewed (changes, then approved) and merged, T2 in progress, preview config on main. */
async function seedProject(wsId: string): Promise<string> {
	const ws = await Workspace.get(wsId);
	const pm = ws.projects;
	pm.build.nudges = false;
	const ana = users.byUsername("ana")!;
	const { project } = await api("POST", `/api/w/${wsId}/projects`, { goal: "A team availability board: who is in the office which day", model: { provider: "pi-os-demo", modelId: "demo" } });
	const pid = project.id as string;
	await pm.stopAll(pid);
	for (const role of ["worker", "worker", "reviewer"]) await pm.addAgent(pid, { role, brief: "wait", start: false });
	const repo = pm.repo(pid);
	await repo.writeMain("docs/requirements.md", "# Requirements\n\n## Acceptance\n- Mon–Fri columns\n", "requirements");
	// two attachments, through the same API the page uses
	const up = (name: string, body: string, type: string) => page.evaluate(async (wsId, name, body, type) => (await (await fetch(`/api/w/${wsId}/files`, { method: "POST", headers: { "x-file-name": name, "content-type": type }, body })).json()).file.id, wsId, name, body, type);
	const files = [await up("brief.txt", "office days matter", "text/plain"), await up("roster.csv", "name\nAna\nBo", "text/csv")];
	await api("POST", `/api/w/${wsId}/projects/${pid}/agents/lead/messages`, { text: "for the requirements", files });
	await pm.stopAll(pid);

	await pm.editBacklog(pid, (b) =>
		addItems(
			b,
			[
				{ ref: "f", type: "feature", title: "Weekly board" },
				{ ref: "p", type: "pbi", parent: "f", title: "See who's in", acceptance: ["Mon–Fri columns"] },
				{ ref: "t1", type: "task", parent: "p", title: "Serve the board page", area: "app/server" },
				{ type: "task", parent: "p", title: "Render the week grid", deps: ["t1"], area: "app/ui" },
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
	write(".pios/project.json", JSON.stringify({ dev: { command: "node server.js", readyPath: "/" } }));
	await pm.build.taskDone(pid, await agent("dev-1"), "board page", false);
	await until("review 1", async () => (await item("T1")).reviewBriefed);
	await pm.build.verdict(pid, await agent("reviewer"), "T1", "changes", "Set the content type");
	await pm.build.taskDone(pid, await agent("dev-1"), "content type set", false);
	await until("review 2", async () => (await item("T1")).reviewBriefed && (await item("T1")).reviewRound === 2);
	await pm.build.verdict(pid, await agent("reviewer"), "T1", "approve", "ok");
	await until("T2 briefed", async () => (await item("T2")).briefed);
	return pid;
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
}
await browser.close().catch(() => {});
await finish();
