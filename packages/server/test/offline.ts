/**
 * The backend goes away and comes back: the web app shows a banner and a toast, keeps everything
 * clickable, reports failed actions clearly, and says when it's back. Runs a real server in a child
 * process so it can be stopped and started again mid-session.
 * Run: pnpm --filter @outpost/server test -- offline
 */
import { check, finish, freePort, sleep, testDir, until } from "./lib/harness.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
const { findBrowser } = await import("../src/modules/render.ts");
const browserPath = findBrowser();
if (!browserPath) {
	console.log("  - skipped: no browser");
	await finish();
}
const port = await freePort();
const dir = join(testDir, "instance");
mkdirSync(dir, { recursive: true });
const tsx = join(import.meta.dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");
let log = "";
function start(): ChildProcess {
	const child = spawn(process.execPath, [tsx, join(import.meta.dirname, "..", "src", "main.ts")], {
		env: { ...process.env, PORT: String(port), OUTPOST_DATA: join(dir, "data"), INIT_CWD: dir, OUTPOST_CONFIG: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (d) => (log += d));
	child.stderr.on("data", (d) => (log += d));
	child.on("exit", (code) => (log += `
[child exited ${code}]`));
	return child;
}
const base = `http://127.0.0.1:${port}`;
const up = async (ms = 40000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			await fetch(`${base}/api/me`);
			return true;
		} catch {
			await sleep(200);
		}
	}
	return false;
};
let server = start();
if (!(await up())) {
	server.kill();
	await finish(new Error(`server didn't start: ${log.slice(-400)}`));
}
process.on("exit", () => server.kill());

const browser = await puppeteer.launch({ executablePath: browserPath!, headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1280, height: 860 } });
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	const dialogs: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("dialog", (d) => {
		dialogs.push(d.message());
		void d.dismiss();
	});
	await page.goto(base, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".auth-form form");
	// Sign up through the same API the form uses, then reload: this suite is about the connection, not the form.
	await page.evaluate(async () => {
		const r = await fetch("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "offline-user", password: "password123", displayName: "Offline" }) });
		if (!r.ok) throw new Error(`signup: ${r.status} ${await r.text()}`);
	});
	await page.goto(base, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".brand .name", { timeout: 20000 });
	check("signed in with a live connection", await until("live dot", () => page.$eval(".kernel .dot", (d) => !d.classList.contains("off")), 10000));
	const text = (sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText).catch(() => "");
	const shot = async (name: string) => process.env.SHOTS && page.screenshot({ path: join(process.env.SHOTS, `offline-${name}.png`) });

	// The backend stops.
	server.kill();
	await until("disconnect noticed", async () => (await fetch(`${base}/api/me`).then(() => false).catch(() => true)), 20000);
	check("a banner says the server can't be reached", await until("banner", () => text(".offline-banner").then((t) => /Can't reach Outpost/.test(t) && /Reconnecting/.test(t)), 15000), await text(".offline-banner"));
	check("…and a toast says the same once", await until("toast", () => page.$$eval(".toast", (ts) => ts.some((t) => /Can't reach Outpost/.test(t.textContent ?? "")))));
	check("the banner shows how long it's been down, and offers Retry", await until("detail", () => text(".offline-banner").then((t) => /down for \d+s/.test(t) && /Retry now/.test(t))), await text(".offline-banner"));
	check("the sidebar says it isn't live", await page.$eval(".kernel .dot", (d) => d.classList.contains("off")));
	check("everything stays usable", await page.$eval(".new-chat button", (b) => !(b as HTMLButtonElement).disabled));
	await shot("banner");

	// An action while it's down fails with a clear message, not silence.
	dialogs.length = 0;
	await page.click(".new-chat button");
	check("an action while offline explains itself", await until("action error", () => page.$$eval(".toast", (ts) => ts.some((t) => /needs Outpost/.test(t.textContent ?? "") && /That didn't work/.test(t.textContent ?? ""))), 8000), await page.$$eval(".toast", (ts) => ts.map((t) => t.textContent)));
	check("…without repeating the banner's wording", (await page.$$eval(".toast", (ts) => ts.filter((t) => /isn't responding/.test(t.textContent ?? "")).length)) === 1);
	check("nothing is queued or half-sent: still on the same page", !!(await page.$(".brand .name")));
	await shot("action-error");
	await page.click(".offline-banner button");
	await sleep(600);
	check("Retry now doesn't pretend it worked", !!(await page.$(".offline-banner")));

	// The backend comes back.
	server = start();
	check("server restarted", await up(40000), log.slice(-300));
	check("the banner goes away by itself", await until("banner gone", async () => !(await page.$(".offline-banner")), 20000));
	check("a toast says it's back", await until("back online toast", () => page.$$eval(".toast", (ts) => ts.some((t) => /Back online/.test(t.textContent ?? ""))), 10000));
	check("the sidebar is live again", await until("live dot", () => page.$eval(".kernel .dot", (d) => !d.classList.contains("off")), 15000));
	check("the page that failed reloads itself, with no stale error", await until("home recovered", async () => !!(await page.$(".home-head")) && !/Couldn't load/.test(await text("body")), 15000));
	await shot("back-online");
	await page.click(".new-chat button");
	check("actions work again", await until("new chat opened", () => page.$(".composer textarea"), 15000));

	// Toasts can be dismissed, and don't pile up.
	await page.evaluate(() => dispatchEvent(new Event("offline")));
	await page.waitForSelector(".toast.error");
	const before = await page.$$eval(".toast", (t) => t.length);
	await page.evaluate(() => dispatchEvent(new Event("offline")));
	await sleep(200);
	check("repeated reports don't stack toasts", (await page.$$eval(".toast", (t) => t.length)) <= Math.max(before, 2));
	check("a drop in the network alone is reported as such", /You're offline/.test(await text(".offline-banner")));
	await page.click(".toast-x");
	check("a toast can be dismissed", await until("dismissed", async () => (await page.$$eval(".toast", (ts) => ts.length)) < before + 1));
	await page.evaluate(() => dispatchEvent(new Event("online")));
	check("coming back online clears it", await until("online again", async () => !(await page.$(".offline-banner")), 10000));
	// Background refreshes reject while the backend is down; that is the point. Anything else would be a real bug.
	const outage = errors.filter((e) => /Can't reach Outpost/.test(e));
	check("failed requests report the outage, and nothing else", outage.length > 0 && errors.length === outage.length, errors.filter((e) => !outage.includes(e)));
} catch (e) {
	server.kill();
	await browser.close();
	await finish(e);
}
server.kill();
await browser.close();
await finish();
