import { writeFileSync } from "node:fs";
import { installBuiltinBlueprints } from "../src/gadgets/blueprints.ts";
import { users, workspaces } from "../src/kernel/system-db.ts";
import { Workspace } from "../src/kernel/workspace.ts";
import { closeRenderer, findBrowser } from "../src/gadgets/render.ts";

installBuiltinBlueprints();
console.log("browser:", findBrowser());
const u = users.create(`r${Date.now().toString(36)}`, "pass1234", "Render");
const w = workspaces.create("render", u.id);
const ws = await Workspace.get(w.id);
const g = await ws.createGadget({ name: "Todo", blueprintId: "bp_todo", ownerId: u.id });
const caller = { kind: "agent" as const, id: "chat", name: "Agent", role: "editor" as const };
await ws.host(g.id).call("add", ["Book the venue", "ana"], caller);
let t = Date.now();
const scratch = await ws.renderGadget(g.id, caller, { width: 800, height: 600, fullPage: false, waitMs: 200, actions: [{ type: { selector: "#text", text: "Scratch only" } }, { press: "Enter" }] });
const after: any = await ws.host(g.id).call("list", [], caller);
if (!scratch.calls.some((c) => c.method === "add" && c.ok) || after.length !== 1) { console.error("FAIL: scratch render leaked into real state", after); process.exit(1); }
console.log("  ✓ default render runs against a scratch copy: real data untouched");
const r = await ws.renderGadget(g.id, caller, { width: 800, height: 600, fullPage: false, waitMs: 200, persist: true, actions: [{ type: { selector: "#text", text: "Order snacks" } }, { press: "Enter" }, { click: ".check" }] });
const ok = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("  ✓", m); };
ok(r.png.length > 1000 && r.image.mimeType.startsWith("image/"), `rendered ${r.width}x${r.height} in ${Date.now() - t}ms`);
ok(["list", "add", "toggle"].every((m) => r.calls.some((c) => c.method === m && c.ok)), "actions drove the real server (type+Enter → add, click → toggle)");
const items: any = await ws.host(g.id).call("list", [], caller);
ok(items.length === 2 && items.some((i: any) => i.text === "Order snacks"), "state changed by the render is durable");
if (process.env.OUT) writeFileSync(process.env.OUT, Buffer.from(r.image.data, "base64"));
// broken client: error surfaces
await ws.writeGadgetFiles(g.id, { "index.html": "<h1>hi</h1><script>console.warn('careful'); gadget.api.nope().catch(e => console.error('rpc failed: ' + e.message)); undefinedFn();</script>" });
t = Date.now();
const r2 = await ws.renderGadget(g.id, caller, { width: 400, height: 300, fullPage: false, waitMs: 100, actions: [{ click: "#missing" }] });
ok(r2.console.some((c) => c.level === "warn" && c.text === "careful"), "console output captured");
ok(r2.console.some((c) => c.level === "error" && /undefinedFn/.test(c.text)), "uncaught client errors captured");
ok(r2.calls.some((c) => c.method === "nope" && !c.ok), "failed RPC calls reported");
ok(r2.actionErrors.some((e) => e.includes("#missing")), "bad action selectors reported");
const full = await ws.renderGadget(g.id, caller, { width: 400, height: 300, fullPage: true, waitMs: 0, actions: [] });
ok(full.height >= 300, "full-page capture");
console.log("ALL GOOD");
await closeRenderer(); await Workspace.closeAll(); process.exit(0);
