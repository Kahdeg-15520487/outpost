import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { hub } from "../collab/hub.ts";
import type { ProjectManager } from "./manager.ts";

/**
 * Live preview (milestone 5): pi-os runs the project's app from `main` and the App tab shows it.
 *
 * - How to run it comes from `.pios/project.json` on main (written by the architect):
 *   `{ "install": "npm install", "test": "npm test", "dev": { "command": "npm run dev -- --port $PORT", "readyPath": "/" } }`
 *   Commands run inside `app/` (or the repo root if there is no app/), in bash (Git Bash on Windows).
 * - It runs in its own checkout of main (`<project>/preview`, detached), never in an agent's tree.
 * - `install` runs when the dependency manifests (package.json, lockfiles, requirements.txt…) or the
 *   install command changed since the last successful install.
 * - `dev` gets a free port in $PORT (also substituted into the command) and HOST=127.0.0.1; it counts
 *   as running once it answers HTTP on readyPath. If the app ignores $PORT, the port it prints
 *   (http://localhost:NNNN) is used instead.
 * - Merges that touch app/ or .pios/ restart it (debounced). Logs are kept in memory (last lines).
 */
export type PreviewStatus = "off" | "no-config" | "installing" | "starting" | "running" | "crashed" | "failed";
export type PreviewInfo = { status: PreviewStatus; port?: number; /** Address that answered: 127.0.0.1, or localhost when the app listens on IPv6 only. */ host?: string; head?: string; error?: string; command?: string; startedAt?: number; readyAt?: number; logSeq: number; stoppedByUser?: boolean };
export type RunConfig = { install?: string; test?: string; dev?: { command: string; readyPath?: string } | string };

const LOG_LIMIT = 1500;
export const MANIFESTS = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "requirements.txt", "pyproject.toml", "poetry.lock", "Gemfile.lock", "go.sum", "Cargo.lock", "composer.lock"];

class Preview {
	info: PreviewInfo = { status: "off", logSeq: 0 };
	logs: { seq: number; at: number; text: string; stream: "out" | "err" | "pi-os" }[] = [];
	proc?: ChildProcess;
	install?: ChildProcess;
	/** Incremented on every start/stop; stale async steps check it and give up. */
	generation = 0;
	/** The dev server's whole process tree once it's up (Windows): killed one by one on stop. */
	tracked: Tracked[] = [];
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

/** A process and its living ancestors (stops before pi-os itself). Git Bash breaks parent chains, so the
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

	constructor(readonly m: ProjectManager) {}

	#get(projectId: string) {
		let p = this.#previews.get(projectId);
		if (!p) this.#previews.set(projectId, (p = new Preview()));
		return p;
	}

	info(projectId: string): PreviewInfo {
		return this.#get(projectId).info;
	}

	logs(projectId: string, since = 0) {
		const p = this.#get(projectId);
		return { seq: p.info.logSeq, lines: p.logs.filter((l) => l.seq > since) };
	}

	/** The last lines as text (for agents). */
	tail(projectId: string, n = 60) {
		return this.#get(projectId)
			.logs.slice(-n)
			.map((l) => (l.stream === "pi-os" ? `[pi-os] ${l.text}` : l.text))
			.join("\n");
	}

	#set(projectId: string, patch: Partial<PreviewInfo>) {
		const p = this.#get(projectId);
		p.info = Object.fromEntries(Object.entries({ ...p.info, ...patch }).filter(([, v]) => v !== undefined)) as PreviewInfo;
		hub.publish(this.m.channel(projectId), { t: "project.preview", ws: this.m.ws.id, project: projectId, preview: p.info });
	}

	#log(projectId: string, text: string, stream: "out" | "err" | "pi-os" = "pi-os") {
		const p = this.#get(projectId);
		const lines = text.replace(/\r\n?/g, "\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
		if (lines.at(-1) === "") lines.pop();
		for (const line of lines) {
			p.info.logSeq += 1;
			p.logs.push({ seq: p.info.logSeq, at: Date.now(), text: line.slice(0, 2000), stream });
		}
		if (p.logs.length > LOG_LIMIT) p.logs.splice(0, p.logs.length - LOG_LIMIT);
		this.#publishLogsSoon(projectId);
	}

	readonly #logTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#publishLogsSoon(projectId: string) {
		if (this.#logTimers.has(projectId)) return;
		this.#logTimers.set(
			projectId,
			setTimeout(() => {
				this.#logTimers.delete(projectId);
				hub.publish(this.m.channel(projectId), { t: "project.preview.log", ws: this.m.ws.id, project: projectId, seq: this.#get(projectId).info.logSeq });
			}, 400),
		);
	}

	/** Serialize start/stop per project. */
	#serial<T>(projectId: string, work: () => Promise<T>): Promise<T> {
		const run = (this.#queue.get(projectId) ?? Promise.resolve()).then(work, work);
		this.#queue.set(
			projectId,
			run.catch(() => {}),
		);
		return run;
	}

	/** Main changed: restart soon if the app's files or run config changed (unless the user stopped it). */
	mainChanged(projectId: string, files: string[]) {
		if (!files.some((f) => f.startsWith("app/") || f.startsWith(".pios/"))) return;
		const p = this.#get(projectId);
		if (p.info.stoppedByUser) return;
		clearTimeout(this.#restartTimers.get(projectId));
		this.#restartTimers.set(
			projectId,
			setTimeout(() => {
				this.#restartTimers.delete(projectId);
				void this.start(projectId, "main changed").catch(() => {});
			}, 2500),
		);
	}

	stop(projectId: string, byUser = false): Promise<void> {
		return this.#serial(projectId, async () => this.#stop(projectId, byUser));
	}

	#stop(projectId: string, byUser: boolean) {
		const p = this.#get(projectId);
		p.generation += 1;
		killTree(p.install);
		killTree(p.proc);
		killTracked(p.tracked);
		p.tracked = [];
		rmSync(this.#pidFile(projectId), { force: true });
		p.install = p.proc = undefined;
		if (byUser) {
			this.#log(projectId, "Stopped");
			rmSync(this.#wantFile(projectId), { force: true });
		}
		this.#set(projectId, { status: "off", port: undefined, host: undefined, error: undefined, readyAt: undefined, stoppedByUser: byUser || undefined });
	}

	stopAll() {
		for (const t of this.#restartTimers.values()) clearTimeout(t);
		this.#restartTimers.clear();
		for (const [id, p] of this.#previews) {
			p.generation += 1;
			killTree(p.install);
			killTree(p.proc);
			killTracked(p.tracked);
			rmSync(this.#pidFile(id), { force: true });
			this.#previews.delete(id);
		}
	}

	/** Present while the preview should run (started, not stopped by the user): a restarted pi-os brings it back. */
	#wantFile(projectId: string) {
		return join(this.m.repo(projectId).root, "preview.want");
	}

	/** After a restart: start the preview again if it was running before. */
	async resume(projectId: string) {
		if (existsSync(this.#wantFile(projectId)) && this.#get(projectId).info.status === "off") await this.start(projectId, "pi-os restarted").catch(() => {});
	}

	#pidFile(projectId: string) {
		return join(this.m.repo(projectId).root, "preview.pids.json");
	}

	/**
	 * Kill what a previous pi-os process left running (it was killed before it could stop its dev
	 * server). Only processes whose pid and creation time both match the record are touched.
	 */
	async reap(projectId: string) {
		const file = this.#pidFile(projectId);
		if (!existsSync(file)) return;
		try {
			const list = JSON.parse(readFileSync(file, "utf8")) as Tracked[];
			if (list.length) killTracked(list, await processTable());
		} catch {}
		rmSync(file, { force: true });
	}

	/** (Re)start the preview from main's HEAD. Resolves once it's running or has failed. */
	start(projectId: string, reason = "start"): Promise<PreviewInfo> {
		return this.#serial(projectId, async () => {
			this.#stop(projectId, false);
			await this.reap(projectId);
			const p = this.#get(projectId);
			const gen = p.generation;
			const stale = () => gen !== p.generation;
			const repo = this.m.repo(projectId);
			let head: string;
			try {
				head = await repo.updatePreview();
			} catch (e: any) {
				this.#set(projectId, { status: "failed", error: `Couldn't check out main: ${e?.message ?? e}` });
				return p.info;
			}
			const root = repo.previewDir;
			const cfgFile = join(root, ".pios", "project.json");
			if (!existsSync(cfgFile)) {
				this.#set(projectId, { status: "no-config", head, error: "No .pios/project.json on main yet. The architect writes it with the design." });
				return p.info;
			}
			let cfg: RunConfig;
			try {
				cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
			} catch (e: any) {
				this.#set(projectId, { status: "failed", head, error: `.pios/project.json isn't valid JSON: ${e?.message ?? e}` });
				return p.info;
			}
			const dev = typeof cfg.dev === "string" ? { command: cfg.dev } : cfg.dev;
			if (!dev?.command) {
				this.#set(projectId, { status: "failed", head, error: '.pios/project.json has no dev command ({ "dev": { "command": "… $PORT" } })' });
				return p.info;
			}
			const cwd = existsSync(join(root, "app")) ? join(root, "app") : root;
			const sh = shell();
			this.#log(projectId, `── ${reason}: main @ ${head}`);

			// install, when the dependency manifests changed
			if (cfg.install) {
				const hash = createHash("sha1").update(cfg.install);
				for (const f of MANIFESTS) if (existsSync(join(cwd, f))) hash.update(f).update(readFileSync(join(cwd, f)));
				const digest = hash.digest("hex");
				const stamp = join(repo.root, "preview-install.sha1");
				const last = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "";
				if (last !== digest) {
					this.#set(projectId, { status: "installing", head, command: cfg.install, startedAt: Date.now(), error: undefined });
					this.#log(projectId, `$ ${cfg.install}`);
					const code = await this.#run(projectId, p, sh, cfg.install, cwd, {}, "install", 15 * 60_000);
					if (stale()) return p.info;
					if (code !== 0) {
						this.#set(projectId, { status: "failed", error: `install failed (exit ${code}): ${cfg.install}` });
						return p.info;
					}
					writeFileSync(stamp, digest);
				}
			}

			// dev server
			const port = await freePort();
			const command = dev.command.replace(/\$\{PORT\}|\$PORT\b|%PORT%/g, String(port));
			this.#set(projectId, { status: "starting", head, port, command, startedAt: Date.now(), error: undefined, readyAt: undefined, stoppedByUser: undefined });
			this.#log(projectId, `$ ${command}`);
			const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", BROWSER: "none", FORCE_COLOR: "0", NODE_ENV: process.env.NODE_ENV === "production" ? "development" : (process.env.NODE_ENV ?? "development") };
			const proc = this.#spawn(sh, command, cwd, env);
			p.proc = proc;
			let printedPort: number | undefined;
			const onData = (stream: "out" | "err") => (d: Buffer) => {
				const s = d.toString("utf8");
				this.#log(projectId, s, stream);
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
				this.#log(projectId, `dev server exited (code ${code})`);
				this.#set(projectId, { status: p.info.status === "running" ? "crashed" : "failed", error: `The dev server exited with code ${code}. See the logs.` });
			});

			// ready: it answers HTTP on readyPath (on $PORT, or the port it printed)
			const readyPath = typeof cfg.dev === "object" && cfg.dev.readyPath ? cfg.dev.readyPath : "/";
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				if (stale() || exited !== undefined) return p.info;
				for (const candidate of [port, ...(printedPort && printedPort !== port ? [printedPort] : [])]) {
					const host = await answers(candidate, readyPath);
					if (host) {
						if (stale()) return p.info;
						if (candidate !== port) this.#log(projectId, `The app ignored $PORT and listens on ${candidate}; using that.`);
						this.#set(projectId, { status: "running", port: candidate, host, readyAt: Date.now() });
						writeFileSync(this.#wantFile(projectId), String(Date.now()));
						this.#log(projectId, `ready on http://${host}:${candidate}${readyPath}`);
						// Remember the whole tree (Windows can't always kill it through npm/bash wrappers).
						if (process.platform === "win32" && proc.pid) {
							const [table, listener] = await Promise.all([processTable(), listenerPid(candidate)]);
							const tree = descendants(table, proc.pid);
							for (const t of listener ? ancestors(table, listener) : []) if (!tree.some((x) => x.pid === t.pid)) tree.push(t);
							if (!stale() && p.proc === proc) {
								p.tracked = tree;
								writeFileSync(this.#pidFile(projectId), JSON.stringify(tree));
							}
						}
						return p.info;
					}
				}
				await new Promise((r) => setTimeout(r, 700));
			}
			if (!stale()) this.#set(projectId, { status: "failed", error: `The dev server didn't answer on port ${port}${readyPath} within 2 minutes. Does the command use $PORT?` });
			return p.info;
		});
	}

	#spawn(sh: string | null, command: string, cwd: string, env: NodeJS.ProcessEnv) {
		const proc = sh ? spawn(sh, ["-c", command], { cwd, env, windowsHide: true, detached: process.platform !== "win32" }) : spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== "win32" });
		live.add(proc);
		return proc;
	}

	#run(projectId: string, p: Preview, sh: string | null, command: string, cwd: string, extraEnv: Record<string, string>, label: string, timeoutMs: number): Promise<number | null> {
		return new Promise((resolve) => {
			const proc = this.#spawn(sh, command, cwd, { ...process.env, CI: "1", FORCE_COLOR: "0", ...extraEnv });
			p.install = proc;
			const timer = setTimeout(() => {
				this.#log(projectId, `${label} timed out after ${Math.round(timeoutMs / 60000)} min`);
				killTree(proc);
			}, timeoutMs);
			proc.stdout?.on("data", (d: Buffer) => this.#log(projectId, d.toString("utf8"), "out"));
			proc.stderr?.on("data", (d: Buffer) => this.#log(projectId, d.toString("utf8"), "err"));
			proc.on("error", (e) => this.#log(projectId, `${label}: ${e.message}`));
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
