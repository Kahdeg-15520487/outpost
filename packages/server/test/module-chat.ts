/** Bidirectional module/chat links: durable associations, legacy recovery, and sidebar/open-button navigation. */
import { check, finish, must, startServer, until } from "./lib/harness.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import puppeteer from "puppeteer-core";
import { ToolTask } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
const base = await startServer();
const { users, sessions, workspaces, modules } = await import("../src/kernel/system-db.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { ChatsDoc } = await import("../src/kernel/docs.ts");
const { createOutpostExtension } = await import("../src/agent/extension.ts");
const { backfillModuleChats } = await import("../src/kernel/module-chats.ts");
const user = users.create("module-owner", "password123", "Module owner");
const workspace = workspaces.create("Module chats", user.id);
let ws = await Workspace.get(workspace.id);
const origin = await ws.createChat(user, "Notes origin", { provider: "outpost-demo", modelId: "demo" });
await ws.send(origin, user, "make notes");
await (await ws.conversation(origin)).waitForIdle(ctx);
const module = modules.inWorkspace(ws.id)[0];
must("demo agent created the module", module);
const linked = async (id: string) => (await ws.harness.snapshot(ChatsDoc, ctx))?.chats[id]?.moduleIds ?? [];
const tool = (name: string, args: any, id: string) => (createOutpostExtension(ws).tools!.find((t) => t.name === name)! as any).execute(args, { conversationId: Number(id), taskId: 90001 }, ctx);
const unrelated = await ws.createChat(user, "Unrelated conversation", { provider: "outpost-demo", modelId: "demo" });
check("creation stores its originating chat", (await linked(origin)).includes(module.id));
await tool("module_list", {}, unrelated);
check("listing modules does not relate an unrelated chat to all of them", (await linked(unrelated)).length === 0);
await ws.linkModuleChat(origin, module.id);
check("repeated activity does not duplicate links", (await linked(origin)).length === 1);
const other = workspaces.create("Another workspace", user.id);
const otherWs = await Workspace.get(other.id);
const foreign = await otherWs.createModule({ name: "Private other module", ownerId: user.id });
await ws.linkModuleChat(origin, foreign.id);
check("links cannot cross workspace boundaries", !(await linked(origin)).includes(foreign.id));

const { findBrowser } = await import("../src/modules/render.ts");
const browserPath = findBrowser();
const browser = browserPath ? await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1400, height: 900 } }) : undefined;
try {
	const page = await browser?.newPage();
	const errors: string[] = [];
	page?.on("pageerror", (e) => errors.push(String(e)));
	const chatRow = (id: string) => `.sidebar [data-chat-id="${id}"] > .side-item`;
	const moduleRow = (id: string) => `.sidebar [data-module-id="${id}"] > .side-item`;
	const go = async (hash: string) => { await page!.goto(`${base}/${hash}`); await page!.waitForSelector(moduleRow(module.id)); };
	const shot = async (name: string) => {
		if (page && process.env.SHOTS) { mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: join(process.env.SHOTS, `module-chat-${name}.png`) }); }
	};
	if (page) {
		await page.setCookie({ name: "outpost_session", value: sessions.create(user.id), domain: "127.0.0.1", path: "/" });
		await go(`#/w/${ws.id}`);
		await page.click(moduleRow(module.id));
		check("opening the module from Home highlights its originating chat", await until("origin highlighted", () => page.$(`${chatRow(origin)}.on`)));
		await go(`#/w/${ws.id}/c/${unrelated}`);
		await page.click(moduleRow(module.id));
		check("opening a module from an unrelated chat selects a related chat instead", await until("correct highlight", async () => !!(await page.$(`${chatRow(origin)}.on`)) && !(await page.$(`${chatRow(unrelated)}.on`))));
		await go(`#/w/${ws.id}/c/${origin}`);
		const open = `.chat-modules a[href*="${module.id}"]`;
		check("chat shows a named Open module link", await until("open module", () => page.$(open)) && (await page.$eval(open, (a) => a.getAttribute("aria-label"))) === `Open module: ${module.name}`);
		check("related module is marked in the sidebar even with no module open", !!(await page.$(`${moduleRow(module.id)}.related:not(.on)`)));
		await page.click(open);
		check("Open link opens the module beside the same chat", await until("paired view", () => page.$(".shell.with-module:not(.chat-hidden) .gwin")) && !!(await page.$(`${chatRow(origin)}.on`)));
		await page.click(chatRow(unrelated));
		check("switching to an unrelated chat closes the unrelated module", await until("chat without module", () => page.$(".shell:not(.with-module)")));
		check("merely navigating has not linked the unrelated chat", (await linked(unrelated)).length === 0);
	}

	const followup = await ws.createChat(user, "Notes follow-up", { provider: "outpost-demo", modelId: "demo" });
	await tool("module_read", { module: module.name }, followup);
	check("working on a module by name relates a second chat", (await linked(followup)).includes(module.id));
	const second = await ws.createModule({ name: "A second module with a long name to check the navigation links", blueprintId: "bp_todo", ownerId: user.id });
	const child = await ws.harness.commit(async (tx) => {
		const call = fauxToolCall("module_list", {});
		const assistant = await tx.appendEntry(Number(origin) as any, { kind: "pi.assistant", model: [fauxAssistantMessage([call], { stopReason: "toolUse" })] });
		const ownerTask = await tx.createTask(ToolTask, { kind: "model", assistant: assistant.id, callId: call.id }, { ownership: { kind: "conversation" }, conversationId: Number(origin) as any });
		return tx.createConversation({ ownership: { kind: "task", taskId: ownerTask } });
	}, ctx);
	await tool("module_read", { module: second.id }, String(child.id));
	check("a subagent's work links to its parent chat", (await linked(origin)).includes(second.id));
	await ws.send(followup, user, "Explain this app", "followUp", [], second.id);
	await (await ws.conversation(followup)).waitForIdle(ctx);
	check("sending a message beside a module records that relationship", (await linked(followup)).includes(second.id));
	await Workspace.close(ws.id);
	ws = await Workspace.get(workspace.id);
	check("links survive closing and reopening the workspace", (await linked(origin)).length === 2 && (await linked(followup)).length === 2);
	if (page) {
		await go(`#/w/${ws.id}/modules/${module.id}?focus=1`);
		check("module-only deep links recover the latest related chat", await until("follow-up selected", () => page.$(`${chatRow(followup)}.on`)));
		check("other related chats have a distinct Related marker", !!(await page.$(`${chatRow(origin)}.related:not(.on) .side-related`)) && !(await page.$(`${chatRow(unrelated)}.related`)));
		await shot("related-chats");
		await page.reload();
		check("the highlight survives browser reload", await until("highlight after reload", () => page.$(`${chatRow(followup)}.on`)));
		await ws.harness.commit(async (tx) => { (await tx.doc(ChatsDoc)).chats[origin]!.updatedAt = Date.now() + 10_000; }, ctx);
		await page.waitForFunction((id) => document.querySelector("[data-chat-id]")?.getAttribute("data-chat-id") === id, {}, origin);
		check("activity in another related chat does not steal the selected chat", !!(await page.$(`${chatRow(followup)}.on`)));
		await go(`#/w/${ws.id}/c/${origin}`);
		check("a chat can open every module it worked on", await until("two Open links", () => page.$$eval(".chat-modules a", (as) => as.length === 2)));
		await shot("open-links");
		await page.setViewport({ width: 850, height: 900 });
		check("module links fit a narrow chat panel", await page.$eval(".chat-modules", (el) => el.scrollWidth <= el.clientWidth));
		await shot("narrow-links");
		await page.setViewport({ width: 1400, height: 900 });
		await ws.archiveChat(followup);
		await go(`#/w/${ws.id}/modules/${module.id}?focus=1`);
		check("archived chats are not selected or exposed in the sidebar", await until("origin after archive", () => page.$(`${chatRow(origin)}.on`)) && !(await page.$(chatRow(followup))));
		await go(`#/modules/${module.id}`);
		check("standalone modules still mark their related chats", await until("standalone related", () => page.$(`${chatRow(origin)}.related`)));
		await page.click(chatRow(origin));
		check("a related chat link from standalone view opens the paired view", await until("standalone to pair", () => page.$(".shell.with-module:not(.chat-hidden)")));
	}

	// Existing chats: recover only explicit platform evidence, not names mentioned in prose or list results.
	const legacy = await ws.createChat(user, "Legacy chat");
	const unlinked = await ws.createModule({ name: "Only listed", ownerId: user.id });
	await ws.harness.commit(async (tx) => {
		delete (await tx.doc(ChatsDoc)).chats[legacy]!.moduleIds;
		await tx.appendEntry(Number(legacy) as any, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", name: "gadget_read", id: "old-read", arguments: { gadget: module.id } }] }] as any });
		await tx.appendEntry(Number(legacy) as any, { kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "module_list", content: [{ type: "text", text: JSON.stringify([{ id: unlinked.id }]) }] }] as any });
		await tx.appendEntry(Number(legacy) as any, { kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "gadget_create", content: [{ type: "text", text: JSON.stringify({ id: second.id }) }] }] as any });
		await tx.appendEntry(Number(legacy) as any, { kind: "outpost.user", data: { text: `I mentioned ${unlinked.id} but didn't work on it` }, model: [{ role: "user", content: `[outpost: the user has module ${module.id} "Notes" open next to this chat.]\nExplain it`, timestamp: Date.now() }] });
	}, ctx);
	await backfillModuleChats(ws);
	check("backfill recovers historical creation, use and focused-message links", (await linked(legacy)).length === 2 && (await linked(legacy)).includes(module.id) && (await linked(legacy)).includes(second.id));
	check("backfill does not link list results or prose mentions", !(await linked(legacy)).includes(unlinked.id));
	await backfillModuleChats(ws);
	check("backfill is idempotent", (await linked(legacy)).length === 2);
	await ws.deleteModule(second.id);
	check("deletion removes dangling relationships", !(await linked(origin)).includes(second.id) && !(await linked(legacy)).includes(second.id));
	if (page) {
		await go(`#/w/${ws.id}/c/${origin}`);
		check("deleted modules have no Open link", await until("one link after delete", () => page.$$eval(".chat-modules a", (as) => as.length === 1)));
		check("no browser errors", errors.length === 0, errors);
	} else console.log("skipped: browser checks (no browser installed)");
} catch (e) { await browser?.close(); await finish(e); }
await browser?.close();
await finish();
