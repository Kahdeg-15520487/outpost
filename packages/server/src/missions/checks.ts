import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MissionManager } from "./manager.ts";
import { MANIFESTS, killTree, shell, type RunConfig } from "./preview.ts";

/**
 * Quality gates around a merge:
 *  - Checks: outpost runs the mission's `test` command (`.outpost/mission.json`) on the exact commit a
 *    developer submits, and again on the merge result when main moved since. Failing work goes back
 *    to the developer with the output; nothing reaches main with failing tests. Runs happen in the
 *    mission's verify checkout, one at a time per mission.
 *  - Definition of done: the reviewer confirms each item before approving.
 */
export type CheckResult = { status: "passed" | "failed" | "skipped"; command?: string; output?: string; ms: number; reason?: string };

export const DEFAULT_DOD = [
	"It does what the task asks, and meets its PBI's acceptance criteria",
	"Tests cover the change, and the test suite passes",
	"It follows the design and the decision records (new significant choices are recorded)",
	"It stays within the repository layout (application code in app/ only)",
	"The app still builds and starts",
];

export type MissionRunConfig = RunConfig & { definitionOfDone?: string[] };

export function readRunConfig(dir: string): MissionRunConfig | undefined {
	const file = join(dir, ".outpost", "mission.json");
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** The mission's definition of done: outpost's defaults plus what `.outpost/mission.json` adds (`definitionOfDone`). */
export function definitionOfDone(cfg: MissionRunConfig | undefined): string[] {
	const extra = Array.isArray(cfg?.definitionOfDone) ? cfg!.definitionOfDone.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
	return [...DEFAULT_DOD, ...extra].slice(0, 20);
}

const TAIL = 80;
const tail = (s: string) => s.split(/\r?\n/).slice(-TAIL).join("\n").trim();

function run(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
	return new Promise((resolve) => {
		const sh = shell();
		const env = { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
		const proc = sh ? spawn(sh, ["-c", command], { cwd, env, windowsHide: true, detached: process.platform !== "win32" }) : spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== "win32" });
		let output = "";
		let timedOut = false;
		const take = (d: Buffer) => {
			output += d.toString("utf8");
			if (output.length > 400_000) output = output.slice(-200_000);
		};
		proc.stdout?.on("data", take);
		proc.stderr?.on("data", take);
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(proc);
		}, timeoutMs);
		proc.on("error", (e) => (output += `\n${e.message}`));
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, output: output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""), timedOut });
		});
	});
}

export class Checks {
	readonly #queues = new Map<string, Promise<unknown>>();
	/** Test command timeout. */
	timeoutMs = 10 * 60_000;

	constructor(readonly m: MissionManager) {}

	#serial<T>(missionId: string, work: () => Promise<T>): Promise<T> {
		const next = (this.#queues.get(missionId) ?? Promise.resolve()).then(work, work);
		this.#queues.set(
			missionId,
			next.catch(() => {}),
		);
		return next;
	}

	/** Run the mission's tests on `commit` (checked out in the verify checkout). */
	run(missionId: string, commit: string): Promise<CheckResult> {
		return this.#serial(missionId, async () => {
			const t0 = Date.now();
			const repo = this.m.repo(missionId);
			await repo.checkoutVerify(commit);
			return this.#test(missionId, repo.verifyDir, t0);
		});
	}

	/** Build the merge of `commit` into the current main (aside, in the verify checkout) and test it. */
	runMerge(missionId: string, commit: string, message: string): Promise<{ conflict?: string; sha?: string; base?: string; result?: CheckResult }> {
		return this.#serial(missionId, async () => {
			const t0 = Date.now();
			const repo = this.m.repo(missionId);
			const prepared = await repo.prepareMerge(commit, message);
			if (prepared.conflict) return { conflict: prepared.conflict };
			return { sha: prepared.sha, base: prepared.base, result: await this.#test(missionId, repo.verifyDir, t0) };
		});
	}

	async #test(missionId: string, root: string, t0: number): Promise<CheckResult> {
		const cfg = readRunConfig(root);
		if (!cfg?.test) return { status: "skipped", ms: Date.now() - t0, reason: cfg ? "no test command in .outpost/mission.json" : "no .outpost/mission.json yet" };
		const cwd = existsSync(join(root, "app")) ? join(root, "app") : root;
		if (cfg.install) {
			const hash = createHash("sha1").update(cfg.install);
			for (const f of MANIFESTS) if (existsSync(join(cwd, f))) hash.update(f).update(readFileSync(join(cwd, f)));
			const digest = hash.digest("hex");
			const stamp = join(this.m.repo(missionId).root, "verify-install.sha1");
			if ((existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "") !== digest || (existsSync(join(cwd, "package.json")) && !existsSync(join(cwd, "node_modules")))) {
				const inst = await run(cfg.install, cwd, this.timeoutMs);
				if (inst.code !== 0) return { status: "failed", command: cfg.install, output: tail(inst.output), ms: Date.now() - t0, reason: inst.timedOut ? "install timed out" : `install failed (exit ${inst.code})` };
				writeFileSync(stamp, digest);
			}
		}
		const r = await run(cfg.test, cwd, this.timeoutMs);
		return { status: r.code === 0 ? "passed" : "failed", command: cfg.test, output: tail(r.output), ms: Date.now() - t0, ...(r.code === 0 ? {} : { reason: r.timedOut ? `timed out after ${Math.round(this.timeoutMs / 60000)} min` : `exit ${r.code}` }) };
	}
}
