import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { hub } from "../collab/hub.ts";
import { config } from "../config.ts";
import type { MissionManager } from "./manager.ts";

/**
 * Live preview (milestone 5): outpost runs the mission's app from `main` and the App tab shows it.
 *
 * - How to run it comes from `.outpost/mission.json` on main (written by the architect):
 *   `{ "install": "npm install", "test": "npm test", "dev": { "command": "npm run dev -- --port $PORT", "readyPath": "/" } }`
 *   Commands run inside `app/` (or the repo root if there is no app/), in bash (Git Bash on Windows).
 * - It runs in its own checkout of main (`<mission>/preview`, detached), never in an agent's tree.
 * - `install` runs when the dependency manifests (package.json, lockfiles, requirements.txt…) or the
 *   install command changed since the last successful install.
 * - `dev` gets a free port in $PORT (also substituted into the command) and HOST=127.0.0.1; it counts
 *   as running once it answers HTTP on readyPath. If the app ignores $PORT, the port it prints
 *   (http://localhost:NNNN) is used instead.
 * - Where the browser reaches it: by default the app's own loopback port. With `preview.ports` set
 *   (a container, or any deployment where loopback isn't the browser's loopback) outpost takes a port
 *   from that range, listens on `preview.bind` itself and pipes bytes to the app — one published
 *   range covers every mission, and WebSockets (HMR) pass through because it's a raw TCP pipe.
 * - Merges that touch app/ or .outpost/ restart it (debounced). Logs are kept in memory (last lines).
 */
export type PreviewStatus = "off" | "no-config" | "installing" | "starting" | "running" | "crashed" | "failed";
export type PreviewInfo = {
	status: PreviewStatus;
	/** The port a browser connects to (the public one when preview.ports is set). */
	port?: number;
	/** The port the dev server itself listens on (loopback); differs from `port` when forwarding. */
	appPort?: number;
	/** Address that answered: 127.0.0.1, or localhost when the app listens on IPv6 only. */
	host?: string;
	head?: string;
	error?: string;
	command?: string;
	startedAt?: number;
	readyAt?: number;
	logSeq: number;
	stoppedByUser?: boolean;
};
export type RunConfig = { install?: string; test?: string; dev?: { command: string; readyPath?: string } | string };

const LOG_LIMIT = 1500;
export const MANIFESTS = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "requirements.txt", "pyproject.toml", "poetry.lock", "Gemfile.lock", "go.sum", "Cargo.lock", "composer.lock"];

class Preview {
	info: PreviewInfo = { status: "off", logSeq: 0 };
	logs: { seq: number; at: number; text: string; stream: "out" | "err" | "outpost" }[] = [];
	proc?: ChildProcess;
	install?: ChildProcess;
	/** Public port → the dev server's loopback port, when preview.ports is set. */
	fwd?: Forwarder;
	/** Incremented on every start/stop; stale async steps check it and give up. */
	generation = 0;
	/** The dev server's whole process tree once it's up (Windows): killed one by one on stop. */
	tracked: Tracked[] = [];
}

/**
 * A raw TCP pipe from a public port to the dev server's loopback port. HTTP and WebSocket both pass
 * through untouched, so HMR keeps working; it exists so a published port reaches an app that only
 * listens on 127.0.0.1 (the container case).
 */
class Forwarder {
	readonly port: number;
	readonly bind: string;
	/** The dev server's port. Reassigned when the app turns out to ignore $PORT. */
	target: number;
	#server?: Server;
	readonly #sockets = new Set<Socket>();

	constructor(port: number, bind: string, target: number) {
		this.port = port;
		this.bind = bind;
		this.target = target;
	}

	/** Resolves once it's listening; rejects when the port is taken (the caller tries the next one). */
	listen(): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = createServer((down) => {
				const up = connect({ port: this.target, host: "127.0.0.1" });
				this.#sockets.add(down).add(up);
				const drop = () => {
					this.#sockets.delete(down);
					this.#sockets.delete(up);
					down.destroy();
					up.destroy();
				};
				down.on("error", drop).on("close", drop);
				up.on("error", drop).on("close", drop);
				down.pipe(up).pipe(down);
			});
			server.once("error", reject);
			server.listen(this.port, this.bind, () => {
				server.removeListener("error", reject);
				server.on("error", (e) => console.error(`preview port ${this.port}:`, e.message));
				this.#server = server;
				resolve();
			});
		});
	}

	close() {
		for (const s of this.#sockets) s.destroy();
		this.#sockets.clear();
		this.#server?.close();
		this.#server = undefined;
	}
}

/** A process we started, identified by pid + creation time so a reused pid is never killed. */
type Tracked = { pid: number; created: string };

/** Every process: pid → parent and creation time (Windows only; elsewhere process groups do the job). */
function processTable(): Promise<Map<number, { ppid: number; created: string }>> {
	return new Promise((resolve) => {
		if (process.platform !== "win32") return resolve(new Map());
		execFile(
			"powershell",
			["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='C';e={$_.CreationDate.ToFileTimeUtc()}} | ConvertTo-Json -Compress"],
			{ windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20000 },
			(err, out) => {
				const table = new Map<number, { ppid: number; created: string }>();
				if (!err) {
					try {
						for (const r of [JSON.parse(out)].flat()) table.set(Number(r.ProcessId), { ppid: Number(r.ParentProcessId), created: String(r.C) });
					} catch {}
				}
				resolve(table);
			},
		);
	});
}

function descendants(table: Map<number, { ppid: number; created: string }>, root: number): Tracked[] {
	const out: Tracked[] = [];
	const queue = [root];
	while (queue.length) {
		const pid = queue.shift()!;
		const me = table.get(pid);
		if (me) out.push({ pid, created: me.created });
		for (const [child, info] of table) if (info.ppid === pid && !out.some((t) => t.pid === child) && !queue.includes(child)) queue.push(child);
	}
	return out;
}

/** A process and its living ancestors (stops before outpost itself). Git Bash breaks parent chains, so the
 * dev server is found from the port it listens on, and walked up from there. */
function ancestors(table: Map<number, { ppid: number; created: string }>, pid: number): Tracked[] {
	const out: Tracked[] = [];
	for (let cur: number | undefined = pid; cur && cur !== process.pid && table.has(cur) && !out.some((t) => t.pid === cur); cur = table.get(cur)!.ppid) out.push({ pid: cur, created: table.get(cur)!.created });
	return out;
}

/** The pid listening on a local TCP port (Windows netstat). */
function listenerPid(port: number): Promise<number | undefined> {
	return new Promise((resolve) => {
		execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 10000 }, (err, out) => {
			if (err) return resolve(undefined);
			const line = out.split(/\r?\n/).find((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l.trim().split(/\s+/)[1] + " "));
			resolve(line ? Number(line.trim().split(/\s+/).at(-1)) : undefined);
		});
	});
}

function killTracked(list: Tracked[], table?: Map<number, { ppid: number; created: string }>) {
	for (const t of list) {
		if (table && table.get(t.pid)?.created !== t.created) continue;
		try {
			if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(t.pid), "/F"], { stdio: "ignore", windowsHide: true });
			else process.kill(t.pid, "SIGKILL");
		} catch {}
	}
}

let shellPath: string | null | undefined;
export function shell(): string | null {
	if (shellPath !== undefined) return shellPath;
	if (process.platform === "win32") {
		const candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map((p) => `${p}\\Git\\bin\\bash.exe`);
		shellPath = candidates.find((c) => existsSync(c)) ?? null;
		if (!shellPath) {
			try {
				shellPath = execFileSync("where", ["bash.exe"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0]?.trim() || null;
			} catch {
				shellPath = null;
			}
		}
	} else shellPath = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
	return shellPath;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as any).port as number;
			srv.close(() => resolve(port));
		});
	});
}

/**
 * The browser-facing port for a preview: the first port in `preview.ports` this outpost can listen on,
 * forwarding to the dev server's loopback port. Listening is the reservation, so two previews can't
 * pick the same port. Undefined when the range is full.
 */
async function publicPort(appPort: number): Promise<Forwarder | undefined> {
	const [start, end] = config.preview.ports!;
	for (let port = start; port <= end; port++) {
		const fwd = new Forwarder(port, config.preview.bind, appPort);
		try {
			await fwd.listen();
			return fwd;
		} catch {
			fwd.close();
		}
	}
	return undefined;
}

/** Kill a process and everything it started (dev servers spawn children). */
export function killTree(p: ChildProcess | undefined) {
	if (!p?.pid || p.exitCode !== null) return;
	try {
		if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		else process.kill(-p.pid, "SIGTERM");
	} catch {
		try {
			p.kill("SIGKILL");
		} catch {}
	}
}

const live = new Set<ChildProcess>();
process.once("exit", () => {
	for (const p of live) killTree(p);
});

export class PreviewManager {
	readonly #previews = new Map<string, Preview>();
	readonly #restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #queue = new Map<string, Promise<unknown>>();

	constructor(readonly m: MissionManager) {}

	#get(missionId: string) {
		let p = this.#previews.get(missionId);
		if (!p) this.#previews.set(missionId, (p = new Preview()));
		return p;
	}

	info(missionId: string): PreviewInfo {
		return this.#get(missionId).info;
	}

	logs(missionId: string, since = 0) {
		const p = this.#get(missionId);
		return { seq: p.info.logSeq, lines: p.logs.filter((l) => l.seq > since) };
	}

	/** The last lines as text (for agents). */
	tail(missionId: string, n = 60) {
		return this.#get(missionId)
			.logs.slice(-n)
			.map((l) => (l.stream === "outpost" ? `[outpost] ${l.text}` : l.text))
			.join("\n");
	}

	#set(missionId: string, patch: Partial<PreviewInfo>) {
		const p = this.#get(missionId);
		p.info = Object.fromEntries(Object.entries({ ...p.info, ...patch }).filter(([, v]) => v !== undefined)) as PreviewInfo;
		hub.publish(this.m.channel(missionId), { t: "mission.preview", ws: this.m.ws.id, mission: missionId, preview: p.info });
	}

	#log(missionId: string, text: string, stream: "out" | "err" | "outpost" = "outpost") {
		const p = this.#get(missionId);
		const lines = text.replace(/\r\n?/g, "\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
		if (lines.at(-1) === "") lines.pop();
		for (const line of lines) {
			p.info.logSeq += 1;
			p.logs.push({ seq: p.info.logSeq, at: Date.now(), text: line.slice(0, 2000), stream });
		}
		if (p.logs.length > LOG_LIMIT) p.logs.splice(0, p.logs.length - LOG_LIMIT);
		this.#publishLogsSoon(missionId);
	}

	readonly #logTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#publishLogsSoon(missionId: string) {
		if (this.#logTimers.has(missionId)) return;
		this.#logTimers.set(
			missionId,
			setTimeout(() => {
				this.#logTimers.delete(missionId);
				hub.publish(this.m.channel(missionId), { t: "mission.preview.log", ws: this.m.ws.id, mission: missionId, seq: this.#get(missionId).info.logSeq });
			}, 400),
		);
	}

	/** Serialize start/stop per mission. */
	#serial<T>(missionId: string, work: () => Promise<T>): Promise<T> {
		const run = (this.#queue.get(missionId) ?? Promise.resolve()).then(work, work);
		this.#queue.set(
			missionId,
			run.catch(() => {}),
		);
		return run;
	}

	/** Main changed: restart soon if the app's files or run config changed (unless the user stopped it). */
	mainChanged(missionId: string, files: string[]) {
		if (!files.some((f) => f.startsWith("app/") || f.startsWith(".outpost/"))) return;
		const p = this.#get(missionId);
		if (p.info.stoppedByUser) return;
		clearTimeout(this.#restartTimers.get(missionId));
		this.#restartTimers.set(
			missionId,
			setTimeout(() => {
				this.#restartTimers.delete(missionId);
				void this.start(missionId, "main changed").catch(() => {});
			}, 2500),
		);
	}

	stop(missionId: string, byUser = false): Promise<void> {
		return this.#serial(missionId, async () => this.#stop(missionId, byUser));
	}

	#stop(missionId: string, byUser: boolean) {
		const p = this.#get(missionId);
		p.generation += 1;
		killTree(p.install);
		killTree(p.proc);
		killTracked(p.tracked);
		p.tracked = [];
		p.fwd?.close();
		p.fwd = undefined;
		rmSync(this.#pidFile(missionId), { force: true });
		p.install = p.proc = undefined;
		if (byUser) {
			this.#log(missionId, "Stopped");
			rmSync(this.#wantFile(missionId), { force: true });
		}
		this.#set(missionId, { status: "off", port: undefined, appPort: undefined, host: undefined, error: undefined, readyAt: undefined, stoppedByUser: byUser || undefined });
	}

	stopAll() {
		for (const t of this.#restartTimers.values()) clearTimeout(t);
		this.#restartTimers.clear();
		for (const [id, p] of this.#previews) {
			p.generation += 1;
			killTree(p.install);
			killTree(p.proc);
			killTracked(p.tracked);
			p.fwd?.close();
			rmSync(this.#pidFile(id), { force: true });
			this.#previews.delete(id);
		}
	}

	/** Present while the preview should run (started, not stopped by the user): a restarted outpost brings it back. */
	#wantFile(missionId: string) {
		return join(this.m.repo(missionId).root, "preview.want");
	}

	/** After a restart: start the preview again if it was running before. */
	async resume(missionId: string) {
		if (existsSync(this.#wantFile(missionId)) && this.#get(missionId).info.status === "off") await this.start(missionId, "outpost restarted").catch(() => {});
	}

	#pidFile(missionId: string) {
		return join(this.m.repo(missionId).root, "preview.pids.json");
	}

	/**
	 * Kill what a previous outpost process left running (it was killed before it could stop its dev
	 * server). Only processes whose pid and creation time both match the record are touched.
	 */
	async reap(missionId: string) {
		const file = this.#pidFile(missionId);
		if (!existsSync(file)) return;
		try {
			const list = JSON.parse(readFileSync(file, "utf8")) as Tracked[];
			if (list.length) killTracked(list, await processTable());
		} catch {}
		rmSync(file, { force: true });
	}

	/** (Re)start the preview from main's HEAD. Resolves once it's running or has failed. */
	start(missionId: string, reason = "start"): Promise<PreviewInfo> {
		return this.#serial(missionId, async () => {
			this.#stop(missionId, false);
			await this.reap(missionId);
			const p = this.#get(missionId);
			const gen = p.generation;
			const stale = () => gen !== p.generation;
			const repo = this.m.repo(missionId);
			let head: string;
			try {
				head = await repo.updatePreview();
			} catch (e: any) {
				this.#set(missionId, { status: "failed", error: `Couldn't check out main: ${e?.message ?? e}` });
				return p.info;
			}
			const root = repo.previewDir;
			const cfgFile = join(root, ".outpost", "mission.json");
			if (!existsSync(cfgFile)) {
				this.#set(missionId, { status: "no-config", head, error: "No .outpost/mission.json on main yet. The architect writes it with the design." });
				return p.info;
			}
			let cfg: RunConfig;
			try {
				cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
			} catch (e: any) {
				this.#set(missionId, { status: "failed", head, error: `.outpost/mission.json isn't valid JSON: ${e?.message ?? e}` });
				return p.info;
			}
			const dev = typeof cfg.dev === "string" ? { command: cfg.dev } : cfg.dev;
			if (!dev?.command) {
				this.#set(missionId, { status: "failed", head, error: '.outpost/mission.json has no dev command ({ "dev": { "command": "… $PORT" } })' });
				return p.info;
			}
			const cwd = existsSync(join(root, "app")) ? join(root, "app") : root;
			const sh = shell();
			this.#log(missionId, `── ${reason}: main @ ${head}`);

			// install, when the dependency manifests changed
			if (cfg.install) {
				const hash = createHash("sha1").update(cfg.install);
				for (const f of MANIFESTS) if (existsSync(join(cwd, f))) hash.update(f).update(readFileSync(join(cwd, f)));
				const digest = hash.digest("hex");
				const stamp = join(repo.root, "preview-install.sha1");
				const last = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "";
				if (last !== digest) {
					this.#set(missionId, { status: "installing", head, command: cfg.install, startedAt: Date.now(), error: undefined });
					this.#log(missionId, `$ ${cfg.install}`);
					const code = await this.#run(missionId, p, sh, cfg.install, cwd, {}, "install", 15 * 60_000);
					if (stale()) return p.info;
					if (code !== 0) {
						this.#set(missionId, { status: "failed", error: `install failed (exit ${code}): ${cfg.install}` });
						return p.info;
					}
					writeFileSync(stamp, digest);
				}
			}

			// dev server
			const appPort = await freePort();
			const fwd = config.preview.ports ? await publicPort(appPort) : undefined;
			if (config.preview.ports && !fwd) {
				this.#set(missionId, { status: "failed", error: `No free port in preview.ports (${config.preview.ports.join("-")}). Stop another preview, or widen the range and publish it.` });
				return p.info;
			}
			p.fwd = fwd;
			const port = fwd?.port ?? appPort;
			const command = dev.command.replace(/\$\{PORT\}|\$PORT\b|%PORT%/g, String(appPort));
			this.#set(missionId, { status: "starting", head, port, appPort, command, startedAt: Date.now(), error: undefined, readyAt: undefined, stoppedByUser: undefined });
			this.#log(missionId, `$ ${command}`);
			const env = { ...process.env, PORT: String(appPort), HOST: "127.0.0.1", BROWSER: "none", FORCE_COLOR: "0", NODE_ENV: process.env.NODE_ENV === "production" ? "development" : (process.env.NODE_ENV ?? "development") };
			const proc = this.#spawn(sh, command, cwd, env);
			p.proc = proc;
			let printedPort: number | undefined;
			const onData = (stream: "out" | "err") => (d: Buffer) => {
				const s = d.toString("utf8");
				this.#log(missionId, s, stream);
				const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/.exec(s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
				if (m) printedPort = Number(m[1]);
			};
			proc.stdout?.on("data", onData("out"));
			proc.stderr?.on("data", onData("err"));
			let exited: number | null | undefined;
			proc.on("exit", (code) => {
				live.delete(proc);
				exited = code;
				if (stale() || p.proc !== proc) return;
				this.#log(missionId, `dev server exited (code ${code})`);
				this.#set(missionId, { status: p.info.status === "running" ? "crashed" : "failed", error: `The dev server exited with code ${code}. See the logs.` });
			});

			// ready: it answers HTTP on readyPath (on $PORT, or the port it printed)
			const readyPath = typeof cfg.dev === "object" && cfg.dev.readyPath ? cfg.dev.readyPath : "/";
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				if (stale() || exited !== undefined) return p.info;
				for (const candidate of [appPort, ...(printedPort && printedPort !== appPort ? [printedPort] : [])]) {
					const host = await answers(candidate, readyPath);
					if (host) {
						if (stale()) return p.info;
						if (candidate !== appPort) {
							this.#log(missionId, `The app ignored $PORT and listens on ${candidate}; using that.`);
							if (fwd) fwd.target = candidate;
						}
						this.#set(missionId, { status: "running", port, appPort: candidate, host, readyAt: Date.now() });
						writeFileSync(this.#wantFile(missionId), String(Date.now()));
						this.#log(missionId, `ready on http://${host}:${candidate}${readyPath}`);
						if (fwd) this.#log(missionId, `public preview on http://${config.preview.bind}:${port} → 127.0.0.1:${candidate}`);
						// Remember the whole tree (Windows can't always kill it through npm/bash wrappers).
						if (process.platform === "win32" && proc.pid) {
							const [table, listener] = await Promise.all([processTable(), listenerPid(candidate)]);
							const tree = descendants(table, proc.pid);
							for (const t of listener ? ancestors(table, listener) : []) if (!tree.some((x) => x.pid === t.pid)) tree.push(t);
							if (!stale() && p.proc === proc) {
								p.tracked = tree;
								writeFileSync(this.#pidFile(missionId), JSON.stringify(tree));
							}
						}
						return p.info;
					}
				}
				await new Promise((r) => setTimeout(r, 700));
			}
			if (!stale()) this.#set(missionId, { status: "failed", error: `The dev server didn't answer on port ${appPort}${readyPath} within 2 minutes. Does the command use $PORT?` });
			return p.info;
		});
	}

	#spawn(sh: string | null, command: string, cwd: string, env: NodeJS.ProcessEnv) {
		const proc = sh ? spawn(sh, ["-c", command], { cwd, env, windowsHide: true, detached: process.platform !== "win32" }) : spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== "win32" });
		live.add(proc);
		return proc;
	}

	#run(missionId: string, p: Preview, sh: string | null, command: string, cwd: string, extraEnv: Record<string, string>, label: string, timeoutMs: number): Promise<number | null> {
		return new Promise((resolve) => {
			const proc = this.#spawn(sh, command, cwd, { ...process.env, CI: "1", FORCE_COLOR: "0", ...extraEnv });
			p.install = proc;
			const timer = setTimeout(() => {
				this.#log(missionId, `${label} timed out after ${Math.round(timeoutMs / 60000)} min`);
				killTree(proc);
			}, timeoutMs);
			proc.stdout?.on("data", (d: Buffer) => this.#log(missionId, d.toString("utf8"), "out"));
			proc.stderr?.on("data", (d: Buffer) => this.#log(missionId, d.toString("utf8"), "err"));
			proc.on("error", (e) => this.#log(missionId, `${label}: ${e.message}`));
			proc.on("close", (code) => {
				clearTimeout(timer);
				live.delete(proc);
				if (p.install === proc) p.install = undefined;
				resolve(code);
			});
		});
	}
}

/** The address the app answers HTTP on (a status below 500), if any. */
async function answers(port: number, path: string): Promise<string | undefined> {
	for (const [host, url] of [["127.0.0.1", "127.0.0.1"], ["localhost", "[::1]"]] as const) {
		try {
			const ctl = new AbortController();
			const t = setTimeout(() => ctl.abort(), 2500);
			const r = await fetch(`http://${url}:${port}${path.startsWith("/") ? path : `/${path}`}`, { signal: ctl.signal, redirect: "manual" });
			clearTimeout(t);
			await r.body?.cancel().catch(() => {});
			if (r.status < 500) return host;
		} catch {}
	}
	return undefined;
}
