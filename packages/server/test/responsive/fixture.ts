/**
 * A hermetic instance for the responsive suite: its own throwaway data directory, a config with no
 * providers but the scripted offline demo, and a small workspace seeded through the real HTTP API so
 * the screenshots have something to look at. Playwright starts this as its `webServer`.
 *
 * Nothing here touches the developer's outpost.config.json, keys or data (same discipline as
 * test/lib/harness.ts), and the port is fixed so Playwright knows where to wait.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "outpost-responsive-"));
process.env.OUTPOST_DATA = join(dir, "data");
process.env.OUTPOST_CONFIG = join(dir, "outpost.config.json");
writeFileSync(process.env.OUTPOST_CONFIG, JSON.stringify({ models: { default: "outpost-demo/demo", demo: true, ambientEnv: false, providers: {} } }));
process.env.INIT_CWD = dir;
process.env.HOST = "127.0.0.1";
const port = Number(process.env.PORT ?? 4599);
process.env.PORT = String(port);
process.removeAllListeners("warning");
process.on("warning", (w) => w.name !== "ExperimentalWarning" && console.warn(w));

const base = `http://127.0.0.1:${port}`;
await import("../../src/main.ts");

// ------------------------------------------------------------------ seed
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, init: RequestInit & { cookie?: string } = {}) {
	const { cookie, ...rest } = init;
	const res = await fetch(`${base}${path}`, { ...rest, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(rest.headers ?? {}) } });
	const text = await res.text();
	if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text}`);
	return { body: text ? JSON.parse(text) : {}, cookie: res.headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ") ?? "" };
}

async function waitForServer() {
	for (let i = 0; i < 120; i++) {
		try {
			await fetch(`${base}/api/me`);
			return;
		} catch {
			await sleep(250);
		}
	}
	throw new Error("the fixture server never came up");
}

async function seed() {
	await waitForServer();
	const signup = await api("/api/auth/signup", { method: "POST", body: JSON.stringify({ username: "reviewer", password: "password123", displayName: "Reviewer" }) });
	const cookie = signup.cookie;
	const { body: workspaces } = await api("/api/workspaces", { cookie });
	const ws = workspaces.workspaces[0].id as string;

	// A chat with one exchange, so the transcript has a user turn, an assistant turn and a tool row.
	const { body: chat } = await api(`/api/w/${ws}/chats`, { method: "POST", cookie, body: JSON.stringify({ title: "Deployment checklist" }) });
	await api(`/api/w/${ws}/chats/${chat.id}/messages`, { method: "POST", cookie, body: JSON.stringify({ content: "List the three things to check before deploying" }) });
	for (let i = 0; i < 120; i++) {
		const { body } = await api(`/api/w/${ws}`, { cookie });
		if (body?.workspace) break;
		await sleep(250);
	}
	await sleep(1500);

	// Two files, so the files table and its preview dialog have something in them.
	const upload = async (name: string, type: string, body: string) => {
		const res = await fetch(`${base}/api/w/${ws}/files`, {
			method: "POST",
			headers: { "content-type": type, "x-file-name": encodeURIComponent(name), cookie },
			body,
		});
		if (!res.ok) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`);
	};
	await upload("release-checklist.md", "text/markdown", ["# Release checklist", "", "- [ ] migrations applied", "- [ ] preview restarted", "- [ ] rollback rehearsed", ""].join("\n"));
	await upload("deployment-notes.txt", "text/plain", ["Deploy at 21:00 UTC.", "The gateway is rebuilt on every release.", ""].join("\n"));

	// One module from a built-in blueprint: something to open beside the chat and to screenshot.
	const { body: blueprints } = await api("/api/blueprints", { cookie });
	const blueprint = (blueprints.blueprints as { id: string; name: string }[]).find((b) => /notes|todo/i.test(b.name)) ?? (blueprints.blueprints as { id: string }[])[0];
	if (blueprint) await api(`/api/w/${ws}/modules`, { method: "POST", cookie, body: JSON.stringify({ name: "Checklist", blueprintId: blueprint.id }) });

	console.log(`seeded ${ws} on ${base}`);
}

await seed();
