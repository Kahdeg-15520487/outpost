/**
 * Agent-team checks that need no model and no server: backlog edits against a real stored
 * document, and the agent environment's path handling. Run: pnpm --filter @pi-os/server test:teams
 */
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_OS_DATA ??= mkdtempSync(join(tmpdir(), "pios-teams-"));
process.env.PI_OS_CONFIG = "";

const { users, workspaces } = await import("../src/kernel/system-db.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { addItems, renderBacklog } = await import("../src/projects/backlog.ts");
const { agentEnv, fromGitBashPath } = await import("../src/projects/env.ts");

let failed = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
	console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
	if (!ok) failed++;
};

// ---------------------------------------------------------------- backlog
const u = users.create("teams", "password123");
const ws = await Workspace.get(workspaces.create("teams", u.id).id);
const p = await ws.projects.create(u, { goal: "Agent team regression project", model: { provider: "pi-os-demo", modelId: "demo" } });
await ws.projects.stopAll(p.id);

await ws.projects.editBacklog(p.id, (b) =>
	addItems(
		b,
		[
			{ ref: "f", type: "feature", title: "Grid" },
			{ ref: "p", type: "pbi", parent: "f", title: "See the week", acceptance: ["Mon–Fri columns"] },
			{ ref: "t1", type: "task", parent: "p", title: "API" },
			{ type: "task", parent: "p", title: "UI", deps: ["t1"], estimate: "M" },
		],
		"planner",
	),
);
let b = await ws.projects.backlog(p.id);
check("items stored with ids F1 P1 T1 T2", ["F1", "P1", "T1", "T2"].every((id) => b.items[id]), Object.keys(b.items));
check("PBI keeps its feature", b.items.P1?.parent === "F1", b.items.P1);
check("tasks keep their PBI", b.items.T1?.parent === "P1" && b.items.T2?.parent === "P1", [b.items.T1, b.items.T2]);
check("dependency by ref resolved", b.items.T2?.deps.join() === "T1", b.items.T2?.deps);
check("sequence advanced", b.seq.task === 2 && b.seq.feature === 1, b.seq);

// A second call can link to existing ids.
await ws.projects.editBacklog(p.id, (b) => addItems(b, [{ type: "task", parent: "P1", title: "Tests", deps: ["T2"] }], "planner"));
b = await ws.projects.backlog(p.id);
check("later call links to existing ids", b.items.T3?.parent === "P1" && b.items.T3?.deps.join() === "T2", b.items.T3);

// Invalid input changes nothing.
const before = Object.keys(b.items).length;
let threw = false;
try {
	await ws.projects.editBacklog(p.id, (b) => addItems(b, [{ type: "task", parent: "F1", title: "wrong parent type" }], "planner"));
} catch {
	threw = true;
}
b = await ws.projects.backlog(p.id);
check("task under a feature is rejected, nothing stored", threw && Object.keys(b.items).length === before, Object.keys(b.items));

check("snapshot lists tasks under their PBI", /### P1 See the week[\s\S]*- \[ \] T2 UI/.test(renderBacklog(b, "x")), renderBacklog(b, "x"));

await ws.projects.updateItem(p.id, "T1", { status: "done" }, u);
await ws.projects.approveBacklog(p.id, u);
b = await ws.projects.backlog(p.id);
check("status update + approval stored", b.items.T1?.status === "done" && b.approval.status === "approved", b.approval);

// ---------------------------------------------------------------- models
const { models: registry } = await import("../src/kernel/models.ts");
const other = registry.getModels("openai")[0]!;
const otherRef = { provider: other.provider, modelId: other.id };
await ws.projects.addAgent(p.id, { role: "worker", brief: "x", start: false });
await ws.projects.setAgentModel(p.id, "dev-1", otherRef, u);
let st = await ws.projects.state(p.id);
const devAgent = await (await ws.conversation(st.agents["dev-1"]!.conversationId)).agent(ctx);
check("agent model switched (record + conversation)", st.agents["dev-1"]!.model?.modelId === other.id && devAgent.model?.modelId === other.id, { record: st.agents["dev-1"]!.model, conv: devAgent.model?.modelId });
let bad = false;
try {
	await ws.projects.setAgentModel(p.id, "dev-1", { provider: "nope", modelId: "x" }, u);
} catch {
	bad = true;
}
check("unknown model rejected", bad);
await ws.projects.setProjectModel(p.id, otherRef, u, false);
st = await ws.projects.state(p.id);
check("project default changed, lead untouched without applyToAgents", (await ws.projects.meta(p.id)).model.modelId === other.id && st.agents.lead!.model?.modelId === "demo", st.agents.lead!.model);
await ws.projects.setProjectModel(p.id, { provider: "pi-os-demo", modelId: "demo" }, u, true);
st = await ws.projects.state(p.id);
const leadAgent = await (await ws.conversation(st.agents.lead!.conversationId)).agent(ctx);
check("applyToAgents switches everyone", Object.values(st.agents).every((a) => a.model?.modelId === "demo") && leadAgent.model?.modelId === "demo", Object.values(st.agents).map((a) => a.model));

// ---------------------------------------------------------------- agent environment
if (process.platform === "win32") {
	const wt = join(process.env.PI_OS_DATA!, "wt");
	mkdirSync(wt, { recursive: true });
	const env = agentEnv(wt);
	const gitBash = `/${wt[0]!.toLowerCase()}${wt.slice(2).replaceAll("\\", "/")}`;
	check("git bash drive path translated", fromGitBashPath(gitBash) === wt, fromGitBashPath(gitBash));
	check("write through git bash path lands in the worktree", (await env.writeFile(`${gitBash}/a.txt`, "x", ctx)).ok && (await env.readTextFile("a.txt", ctx)).ok);
	check("write outside the worktree refused", !(await env.writeFile(join(process.env.PI_OS_DATA!, "out.txt"), "x", ctx)).ok);
}

await Workspace.closeAll();
console.log(failed ? `\n${failed} FAILED` : "\nALL GOOD");
process.exit(failed ? 1 : 0);
