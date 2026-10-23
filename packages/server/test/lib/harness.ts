/**
 * Shared test harness. Import it FIRST (before anything from src/): it gives the test its own throwaway
 * data dir and keeps pi-os from reading the developer's pi-os.config.json, keys or data. Then:
 *   check(name, ok, detail)   record a result
 *   until(what, fn, ms)       poll until fn returns something truthy
 *   startServer()             boot pi-os in this process on a free port (or use $BASE if set)
 *   finish()                  stop everything, print the summary, exit 0/1
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const testDir = mkdtempSync(join(tmpdir(), "pios-test-"));
// The runner (test/run.ts) deletes it after this process exits; on Windows the open databases keep
// this process from deleting it itself.
console.log(`[harness] dir ${testDir}`);
process.env.PI_OS_DATA = join(testDir, "data");
process.env.PI_OS_CONFIG = "";
// pnpm sets INIT_CWD to where it was invoked (the repo root, next to the developer's config).
process.env.INIT_CWD = testDir;
process.env.HOST = "127.0.0.1";
// Chosen now, before anything reads the config (it fixes the port at import).
process.env.PORT = String(await freePortNow());
process.removeAllListeners("warning");
process.on("warning", (w) => w.name !== "ExperimentalWarning" && console.warn(w));

let failed = 0;
let passed = 0;
export function check(name: string, ok: unknown, detail?: unknown) {
	if (ok) passed++;
	else failed++;
	console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	return !!ok;
}

/** Throws (ending the test) when a precondition the rest depends on fails. */
export function must(name: string, ok: unknown, detail?: unknown): asserts ok {
	if (!check(name, ok, detail)) throw new Error(`stopped: ${name}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(what: string, fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms = 20000): Promise<T | undefined> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await Promise.resolve()
			.then(fn)
			.catch(() => undefined);
		if (v) return v as T;
		await sleep(150);
	}
	console.log(`    … timed out waiting for ${what}`);
	return undefined;
}

function freePortNow(): Promise<number> {
	return freePort();
}

export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as any).port as number;
			srv.close(() => resolve(port));
		});
	});
}

/** Boot pi-os (API, sockets, built web app) in this process on a free port; $BASE uses an external server instead. */
export async function startServer(): Promise<string> {
	if (process.env.BASE) return process.env.BASE;
	const port = Number(process.env.PORT);
	await import("../../src/main.ts");
	const base = `http://127.0.0.1:${port}`;
	if (!(await until("the server", () => fetch(`${base}/api/me`).then(() => true), 30000))) throw new Error("server didn't start");
	return base;
}

/** Stop agents, previews and the renderer, remove the temp dir, print the summary and exit. */
export async function finish(error?: unknown): Promise<never> {
	if (error) {
		failed++;
		console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
		if (error instanceof Error && !error.message.startsWith("stopped:")) console.log(error.stack?.split("\n").slice(1, 6).join("\n"));
	}
	try {
		const { Workspace } = await import("../../src/kernel/workspace.ts");
		await Promise.race([Workspace.closeAll(), sleep(10000)]);
		const { closeRenderer } = await import("../../src/gadgets/render.ts");
		await closeRenderer().catch(() => {});
	} catch {}
	console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nALL GOOD (${passed} checks)`);
	setTimeout(() => {
		try {
			rmSync(testDir, { recursive: true, force: true, maxRetries: 3 });
		} catch {}
		process.exit(failed ? 1 : 0);
	}, 300);
	return new Promise<never>(() => {});
}

/** Mark a project's requirements and design approved (for suites that test what comes after M2's gates). */
export async function passDocGates(ws: { harness: any }, projectId: string) {
	const { ProjectDoc } = await import("../../src/projects/docs.ts");
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	await ws.harness.commit(async (tx: any) => {
		const st = await tx.doc(ProjectDoc, projectId, null);
		st.gates = { requirements: { status: "approved" }, design: { status: "approved" } };
	}, BACKGROUND_CONTEXT);
}
