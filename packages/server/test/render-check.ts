import { finish, must } from "./lib/harness.ts";
import { writeFileSync } from "node:fs";
import { installBuiltinBlueprints } from "../src/modules/blueprints.ts";
import { users, workspaces } from "../src/kernel/system-db.ts";
import { Workspace } from "../src/kernel/workspace.ts";
import { closeRenderer, findBrowser } from "../src/modules/render.ts";

installBuiltinBlueprints();
if (!findBrowser()) {
	console.log("  - skipped: no Chrome/Edge/Chromium found (set OUTPOST_CHROME)");
	await finish();
}
const u = users.create(`r${Date.now().toString(36)}`, "pass1234", "Render");
const w = workspaces.create("render", u.id);
const ws = await Workspace.get(w.id);
const g = await ws.createModule({ name: "Todo", blueprintId: "bp_todo", ownerId: u.id });
const caller = { kind: "agent" as const, id: "chat", name: "Agent", role: "editor" as const };
await ws.host(g.id).call("add", ["Book the venue", "ana"], caller);
let t = Date.now();
const scratch = await ws.renderModule(g.id, caller, { width: 800, height: 600, fullPage: false, waitMs: 200, actions: [{ type: { selector: "#text", text: "Scratch only" } }, { press: "Enter" }] });
const after: any = await ws.host(g.id).call("list", [], caller);
const ok = (c: unknown, m: string) => must(m, c);
ok(scratch.calls.some((c) => c.method === "add" && c.ok) && after.length === 1, "default render runs against a scratch copy: real data untouched");
const r = await ws.renderModule(g.id, caller, { width: 800, height: 600, fullPage: false, waitMs: 200, persist: true, actions: [{ type: { selector: "#text", text: "Order snacks" } }, { press: "Enter" }, { click: ".check" }] });

ok(r.png.length > 1000 && r.image.mimeType.startsWith("image/"), `rendered ${r.width}x${r.height} in ${Date.now() - t}ms`);
ok(["list", "add", "toggle"].every((m) => r.calls.some((c) => c.method === m && c.ok)), "actions drove the real server (type+Enter → add, click → toggle)");
const items: any = await ws.host(g.id).call("list", [], caller);
ok(items.length === 2 && items.some((i: any) => i.text === "Order snacks"), "state changed by the render is durable");
if (process.env.OUT) writeFileSync(process.env.OUT, Buffer.from(r.image.data, "base64"));
// broken client: error surfaces
await ws.writeModuleFiles(g.id, { "index.html": "<h1>hi</h1><script>console.warn('careful'); module.api.nope().catch(e => console.error('rpc failed: ' + e.message)); undefinedFn();</script>" });
t = Date.now();
const r2 = await ws.renderModule(g.id, caller, { width: 400, height: 300, fullPage: false, waitMs: 100, actions: [{ click: "#missing" }] });
ok(r2.console.some((c) => c.level === "warn" && c.text === "careful"), "console output captured");
ok(r2.console.some((c) => c.level === "error" && /undefinedFn/.test(c.text)), "uncaught client errors captured");
ok(r2.calls.some((c) => c.method === "nope" && !c.ok), "failed RPC calls reported");
ok(r2.actionErrors.some((e) => e.includes("#missing")), "bad action selectors reported");
const full = await ws.renderModule(g.id, caller, { width: 400, height: 300, fullPage: true, waitMs: 0, actions: [] });
ok(full.height >= 300, "full-page capture");

// Keyboard: a press with nothing focused used to land on the host page, so a working feature looked
// broken. The module answers ArrowRight by calling its server, which shows up in the RPC log.
await ws.writeModuleFiles(g.id, {
	"index.html": `<h1 id="n">0</h1><script>
		let n = 0;
		document.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") module.api.add("key " + ++n, "ana"); });
	</script>`,
});
const keys = await ws.renderModule(g.id, caller, { width: 400, height: 300, fullPage: false, waitMs: 300, actions: [{ press: "ArrowRight" }, { press: "ArrowRight" }] });
const handled = keys.calls.filter((c) => c.method === "add" && c.ok).length;
ok(handled === 2, `a press with nothing focused reaches the module (${handled} of 2 seen by the page)`);
ok(keys.actionErrors.length === 0, `no action errors (${keys.actionErrors.join("; ")})`);
await finish();
