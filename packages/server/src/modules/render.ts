import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Frame } from "puppeteer-core";
import { config } from "../config.ts";

/**
 * Headless rendering of module clients, so the agent can see what it built. The module runs in the
 * same sandbox as in the shell (iframe sandbox="allow-scripts" + the frame CSP); the host page
 * relays its RPC calls to the module server, all network requests are blocked, and console output,
 * uncaught errors and RPC failures are collected alongside the screenshot.
 */

export type RenderAction =
	| { click: string }
	| { hover: string }
	| { type: { selector: string; text: string } }
	| { press: string }
	| { scroll: { selector?: string; y: number } }
	| { wait: number };

export type RenderOptions = {
	html: string;
	width: number;
	height: number;
	fullPage: boolean;
	waitMs: number;
	actions: RenderAction[];
	call(method: string, args: unknown[]): Promise<unknown>;
};

export type RenderResult = {
	png: Buffer;
	width: number;
	height: number;
	console: { level: string; text: string }[];
	calls: { method: string; ok: boolean; ms: number; error?: string }[];
	actionErrors: string[];
	timedOut: boolean;
};

// ------------------------------------------------------------------ browser discovery

function newestIn(dir: string, prefix: string, rel: string[]): string | undefined {
	if (!existsSync(dir)) return undefined;
	for (const name of readdirSync(dir).filter((n) => n.startsWith(prefix)).sort().reverse()) {
		for (const r of rel) {
			const p = join(dir, name, r);
			if (existsSync(p)) return p;
		}
	}
	return undefined;
}

export function findBrowser(): string | undefined {
	if (config.render.chromePath) return existsSync(config.render.chromePath) ? config.render.chromePath : undefined;
	const env = process.env;
	const candidates: (string | undefined)[] = [];
	let playwright: string;
	if (process.platform === "win32") {
		for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
			if (!base) continue;
			candidates.push(join(base, "Google/Chrome/Application/chrome.exe"), join(base, "Chromium/Application/chrome.exe"), join(base, "Microsoft/Edge/Application/msedge.exe"));
		}
		playwright = join(env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "ms-playwright");
	} else if (process.platform === "darwin") {
		candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
		playwright = join(homedir(), "Library/Caches/ms-playwright");
	} else {
		candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge");
		playwright = join(homedir(), ".cache/ms-playwright");
	}
	const found = candidates.find((c) => c && existsSync(c));
	if (found) return found;
	return (
		newestIn(playwright, "chromium-", ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]) ??
		newestIn(playwright, "chromium_headless_shell-", ["chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell"])
	);
}

// ------------------------------------------------------------------ browser lifecycle

let browser: Promise<Browser> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let active = 0;
const queue: (() => void)[] = [];
const MAX_PARALLEL = 2;

function getBrowser(): Promise<Browser> {
	if (!browser) {
		const executablePath = findBrowser();
		if (!executablePath) {
			throw new Error("No Chrome/Chromium/Edge found for rendering. Install one, or set render.chromePath in outpost.config.json (or OUTPOST_CHROME).");
		}
		const launch = () =>
			puppeteer.launch({
				executablePath,
				headless: true,
				// A cold start (first run, slow disk, CI) can take well over puppeteer's 30 s default.
				timeout: 90_000,
				args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-extensions", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
			});
		browser = launch()
			.catch(launch) // one retry: the second start is usually fast
			.then((b) => {
				b.on("disconnected", () => (browser = undefined));
				return b;
			})
			.catch((error) => {
				browser = undefined;
				throw new Error(`Could not start ${executablePath}: ${error.message}`);
			});
	}
	return browser;
}

async function slot<T>(work: () => Promise<T>): Promise<T> {
	if (active >= MAX_PARALLEL) await new Promise<void>((r) => queue.push(r));
	active++;
	clearTimeout(idle);
	try {
		return await work();
	} finally {
		active--;
		queue.shift()?.();
		if (active === 0) idle = setTimeout(() => void browser?.then((b) => b.close()).catch(() => {}), 180_000);
	}
}

export async function closeRenderer() {
	await browser?.then((b) => b.close()).catch(() => {});
}

// ------------------------------------------------------------------ render

const HOST = (srcdoc: string) => `<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head><body>
<iframe id="g" sandbox="allow-scripts allow-forms allow-modals" srcdoc="${srcdoc.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>
<script>
  const f = document.getElementById("g");
  addEventListener("message", async (e) => {
    if (e.source !== f.contentWindow) return;
    const m = e.data;
    if (!m || m.__outpost !== 1) return;
    const reply = (msg) => f.contentWindow.postMessage(Object.assign({ __outpost: 1 }, msg), "*");
    if (m.t === "call") {
      try { reply({ t: "result", id: m.id, ok: true, value: JSON.parse(await window.__outpostCall(String(m.method), JSON.stringify(m.args || []))) }); }
      catch (err) { reply({ t: "result", id: m.id, ok: false, error: String(err && err.message || err) }); }
    } else if (m.t === "ready") {
      reply({ t: "presence", users: [{ id: "agent", name: "Agent", connections: 1 }] });
      window.__outpostReady();
    } else if (m.t === "error") window.__outpostLog("error", String(m.message));
    else if (m.t === "console") window.__outpostLog(String(m.level), String(m.text));
  });
</script></body></html>`;

export function renderModule(opts: RenderOptions): Promise<RenderResult> {
	return slot(async () => {
		const b = await getBrowser();
		const context = await b.createBrowserContext();
		const page = await context.newPage();
		const consoleLines: RenderResult["console"] = [];
		const calls: RenderResult["calls"] = [];
		const actionErrors: string[] = [];
		let pending = 0;
		let lastActivity = Date.now();
		let ready!: () => void;
		const readyP = new Promise<void>((r) => (ready = r));
		try {
			await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1 });
			// Nothing leaves the box: no network at all, even if CSP were bypassed.
			await page.setRequestInterception(true);
			page.on("request", (req) => (/^(data|blob|about):/.test(req.url()) ? req.continue() : req.abort("blockedbyclient")));
			page.on("dialog", (d) => void d.dismiss().catch(() => {}));
			await page.exposeFunction("__outpostReady", () => ready());
			await page.exposeFunction("__outpostLog", (level: string, text: string) => {
				if (consoleLines.length < 200) consoleLines.push({ level, text });
			});
			await page.exposeFunction("__outpostCall", async (method: string, argsJson: string) => {
				pending++;
				const started = Date.now();
				try {
					const value = await opts.call(method, JSON.parse(argsJson));
					calls.push({ method, ok: true, ms: Date.now() - started });
					return JSON.stringify(value ?? null);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					calls.push({ method, ok: false, ms: Date.now() - started, error: message });
					throw new Error(message);
				} finally {
					pending--;
					lastActivity = Date.now();
				}
			});
			await page.setContent(HOST(opts.html), { waitUntil: "load", timeout: 15_000 });

			// Settle: frame ready, then no RPC in flight and a short quiet period (bounded).
			const deadline = Date.now() + 10_000;
			const settle = async (quietMs: number) => {
				while (Date.now() < deadline && (pending > 0 || Date.now() - lastActivity < quietMs)) await sleep(50);
			};
			await Promise.race([readyP, sleep(5_000)]);
			lastActivity = Date.now();
			await settle(250);

			const frame = page.frames().find((f) => f !== page.mainFrame());
			for (const action of opts.actions.slice(0, 20)) {
				try {
					await runAction(frame, page, action);
				} catch (error) {
					actionErrors.push(`${JSON.stringify(action)}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
				}
				lastActivity = Date.now();
				await settle(200);
			}
			await sleep(Math.min(Math.max(opts.waitMs, 0), 10_000));
			const timedOut = pending > 0;

			let height = opts.height;
			if (opts.fullPage && frame) {
				const docHeight = await frame
					.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0))
					.catch(() => opts.height);
				height = Math.min(Math.max(docHeight, opts.height), 4000);
				if (height !== opts.height) {
					await page.setViewport({ width: opts.width, height, deviceScaleFactor: 1 });
					await sleep(150);
				}
			}
			const png = Buffer.from(await page.screenshot({ type: "png" }));
			return { png, width: opts.width, height, console: consoleLines, calls, actionErrors, timedOut };
		} finally {
			await context.close().catch(() => {});
		}
	});
}

async function runAction(frame: Frame | undefined, page: import("puppeteer-core").Page, action: RenderAction) {
	if (!frame) throw new Error("module frame did not load");
	if ("wait" in action) return sleep(Math.min(action.wait, 5_000));
	if ("click" in action) return frame.click(action.click);
	if ("hover" in action) return frame.hover(action.hover);
	if ("type" in action) return frame.type(action.type.selector, action.type.text);
	if ("press" in action) return page.keyboard.press(action.press as any);
	if ("scroll" in action)
		return frame.evaluate(
			(sel, y) => {
				const el = sel ? document.querySelector(sel) : document.scrollingElement;
				if (!el) throw new Error(`no element ${sel}`);
				el.scrollTop = y;
			},
			action.scroll.selector ?? "",
			action.scroll.y,
		);
	throw new Error("unknown action");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
