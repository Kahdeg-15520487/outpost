import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationRecord, Cursor } from "@earendil-works/pi-durable";
import { ChatsDoc } from "./docs.ts";
import { modules } from "./system-db.ts";
import type { Workspace } from "./workspace.ts";

/** One-time recovery for chats that predate stored module links. Never infer links from arbitrary prose. */
export async function backfillModuleChats(ws: Workspace): Promise<void> {
	const chats = (await ws.harness.snapshot(ChatsDoc, ctx))?.chats ?? {};
	const missing = new Set(Object.values(chats).filter((c) => c.moduleIds === undefined).map((c) => c.id));
	if (!missing.size) return;
	const known = modules.inWorkspace(ws.id);
	const found = new Map([...missing].map((id) => [id, new Set<string>()]));
	const conversations = new Map<string, ConversationRecord>();
	let cursor: Cursor | undefined;
	do {
		const page = await ws.harness.commit((tx) => tx.scanConversations({}, 100, cursor), ctx);
		for (const c of page.items) conversations.set(String(c.id), c);
		cursor = page.next;
	} while (cursor);
	const rootChat = (id: string) => {
		for (let depth = 0; depth < 16; depth++) {
			if (chats[id]) return missing.has(id) ? id : undefined;
			const parent = conversations.get(id)?.owner?.conversationId;
			if (parent === undefined) return;
			id = String(parent);
		}
	};
	for (const conversation of conversations.values()) {
		const root = rootChat(String(conversation.id));
		if (!root) continue; // mission agents and unrelated conversations aren't sidebar chats
		const add = (ref: unknown) => {
			if (typeof ref !== "string") return;
			const byId = known.find((m) => m.id === ref);
			const matches = byId ? [byId] : known.filter((m) => m.name.toLowerCase() === ref.toLowerCase());
			if (matches.length === 1) found.get(root)!.add(matches[0]!.id);
		};
		const call = (name: string, args: any) => {
			// Old names are historical records, not runtime aliases.
			if (/^(?:module|gadget)_(?:read|write|edit|delete_file|call|screenshot|logs)$/.test(name) || /^(?:blueprint_publish|file_share_with_module|file_share_with_gadget)$/.test(name)) add(args?.module ?? args?.gadget);
			if (name === "request_access") add(args?.forModule ?? args?.forGadget);
		};
		cursor = undefined;
		do {
			const page = await ws.harness.commit((tx) => tx.scanEntries({ conversationId: conversation.id }, 100, cursor), ctx);
			for (const entry of page.items) {
				if (entry.kind === "outpost.user") add((entry.data as any)?.moduleId);
				for (const message of (entry.model ?? []) as any[]) {
					const blocks = Array.isArray(message.content) ? message.content : [];
					if (message.role === "assistant") for (const b of blocks) if (b.type === "toolCall") call(b.name, b.arguments);
					if (message.role === "toolResult" && /^(?:module|gadget)_create$/.test(message.toolName) && !message.isError) {
						for (const b of blocks) if (b.type === "text") { try { add(JSON.parse(b.text).id); } catch { /* not a creation result */ } }
					}
					if (entry.kind === "outpost.user" && message.role === "user") {
						const first = typeof message.content === "string" ? message.content : blocks[0]?.text;
						// The shell used to record the open module only in this generated model-context prefix.
						if (typeof first === "string") add(/^\[(?:pi-os|outpost|Outpost): the user has (?:gadget|module) ([\w-]+) "/.exec(first)?.[1]);
					}
				}
			}
			cursor = page.next;
		} while (cursor);
		cursor = undefined;
		do {
			const page = await ws.harness.commit((tx) => tx.scanTasks({ conversationId: conversation.id, kind: "pi.tool" }, 100, cursor), ctx);
			for (const t of page.items) {
				const input = t.input as any;
				if (input?.kind === "nested" && input.call) call(input.call.name, input.call.arguments);
			}
			cursor = page.next;
		} while (cursor);
	}
	await ws.harness.commit(async (tx) => {
		const current = (await tx.doc(ChatsDoc)).chats;
		for (const [id, ids] of found) if (current[id]) {
			current[id].moduleIds = [...new Set([...(current[id].moduleIds ?? []), ...ids])].filter((m) => modules.get(m)?.workspaceId === ws.id);
		}
	}, ctx);
}
