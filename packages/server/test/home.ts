/**
 * The workspace homepage: "while you were away" is recorded per finished agent run, and "seen" is
 * what the next visit measures from. Uses the offline demo model, so no API key is needed.
 * Run: pnpm --filter @outpost/server test:home
 */
import { check, finish, startServer, until } from "./lib/harness.ts";

const base = await startServer();
process.on("unhandledRejection", (e) => void finish(e));

function client() {
	let cookie = "";
	return async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
		const set = res.headers.get("set-cookie");
		if (set) cookie = set.split(";")[0]!;
		const json = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
		return json as any;
	};
}

const suffix = Date.now().toString(36);
const ana = client();
const ben = client();
await ana("POST", "/api/auth/signup", { username: `home${suffix}`, password: "pass1234", displayName: "Ana" });
await ben("POST", "/api/auth/signup", { username: `home${suffix}b`, password: "pass1234", displayName: "Ben" });
const ws = (await ana("GET", "/api/workspaces")).workspaces[0].id;

console.log("first visit");
const fresh = await ana("GET", `/api/w/${ws}/home`);
check("a workspace you never opened says so", fresh.firstVisit === true, fresh.firstVisit);
check("and looks back a week instead of showing nothing", fresh.now - fresh.since > 6 * 24 * 3600_000, fresh.since);
check("nothing happened yet", fresh.away.totals.runs === 0 && fresh.away.chats.length === 0, fresh.away);
check("no last chat to pick up", !fresh.pickup.lastChat, fresh.pickup);

const chat = (await ana("POST", `/api/w/${ws}/chats`, { title: "Offsite todo", model: { provider: "outpost-demo", modelId: "demo" } })).id;

console.log("an agent run while nobody was watching");
await ana("POST", `/api/w/${ws}/chats/${chat}/messages`, { content: "list my modules" });
const away = await until("the run to be recorded", async () => {
	const h = await ana("GET", `/api/w/${ws}/home`);
	return h.away.totals.runs > 0 ? h : undefined;
}, 30000);
check("the run is in the away digest", away?.away.totals.runs === 1, away?.away.totals);
const run = away?.away.chats[0];
check("grouped under its chat, with the chat's title", run?.chatId === chat && run?.title === "Offsite todo", run);
check("it counts the agent's message", (run?.messages ?? 0) >= 1, run?.messages);
check("it names the tools the agent used", run?.tools.some((t: any) => t.name === "module_list"), run?.tools);
check("it keeps the agent's last words as a snippet", !!run?.snippet && run.snippet.length > 0, run?.snippet);
check("the last chat is offered to pick up", away?.pickup.lastChat?.id === chat, away?.pickup.lastChat);

console.log("seen");
const seen = await ana("POST", `/api/w/${ws}/home/seen`);
check("marking it seen returns the new boundary", Math.abs(seen.since - Date.now()) < 5000, seen.since);
const after = await ana("GET", `/api/w/${ws}/home`);
check("after seeing it, the digest is empty", after.away.totals.runs === 0, after.away.totals);
check("and it isn't a first visit any more", after.firstVisit === false, after.firstVisit);
check("the old run is still remembered, just not 'away'", after.since > away!.since, [after.since, away!.since]);

console.log("a second visit only reports what is new");
await ana("POST", `/api/w/${ws}/chats/${chat}/messages`, { content: "list my modules" });
const second = await until("the new run", async () => {
	const h = await ana("GET", `/api/w/${ws}/home`);
	return h.away.totals.runs > 0 ? h : undefined;
}, 30000);
check("the new run shows up", second?.away.totals.runs === 1, second?.away.totals);
check("only the new one: the seen boundary held", second?.away.chats[0]?.runs === 1, second?.away.chats[0]);

console.log("summaries");
const summary = await ana("POST", `/api/w/${ws}/home/summaries`, { chats: [chat] });
check("the demo model says it can't summarise", /demo model/i.test(summary.skipped ?? ""), summary);
check("and returns no summaries rather than inventing one", Object.keys(summary.summaries ?? {}).length === 0, summary.summaries);

console.log("who may read it");
let denied: any;
try {
	await ben("GET", `/api/w/${ws}/home`);
} catch (error) {
	denied = error;
}
check("someone outside the workspace can't read the homepage (404, so it doesn't leak either)", /404/.test(String(denied)), String(denied));

await finish();
