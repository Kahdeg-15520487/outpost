import type { User } from "../kernel/system-db.ts";

/**
 * Fan-out of realtime messages to WebSocket clients, by channel:
 *   ws:<workspaceId>        workspace documents (chats, grants, approvals, modules)
 *   conv:<ws>:<conv>        agent events of one conversation (shared by everyone watching it)
 *   module:<moduleId>       module server broadcasts, reloads, presence
 */
export type HubClient = { id: string; user: User; send(message: unknown): void };

const channels = new Map<string, Set<HubClient>>();
const listeners = new Map<string, Set<(event: "join" | "leave", client: HubClient) => void>>();

export const hub = {
	join(channel: string, client: HubClient) {
		let set = channels.get(channel);
		if (!set) channels.set(channel, (set = new Set()));
		if (set.has(client)) return;
		set.add(client);
		for (const l of listeners.get(channel) ?? []) l("join", client);
	},
	leave(channel: string, client: HubClient) {
		const set = channels.get(channel);
		if (!set?.delete(client)) return;
		if (set.size === 0) channels.delete(channel);
		for (const l of listeners.get(channel) ?? []) l("leave", client);
	},
	leaveAll(client: HubClient) {
		for (const [channel, set] of [...channels]) if (set.has(client)) hub.leave(channel, client);
	},
	publish(channel: string, message: unknown) {
		for (const client of channels.get(channel) ?? []) client.send(message);
	},
	members(channel: string): HubClient[] {
		return [...(channels.get(channel) ?? [])];
	},
	/** Distinct users on a channel (one entry per user, however many tabs). */
	presence(channel: string) {
		const seen = new Map<string, { id: string; name: string; connections: number }>();
		for (const c of channels.get(channel) ?? []) {
			const p = seen.get(c.user.id) ?? { id: c.user.id, name: c.user.displayName, connections: 0 };
			p.connections++;
			seen.set(c.user.id, p);
		}
		return [...seen.values()];
	},
	onMembership(channel: string, listener: (event: "join" | "leave", client: HubClient) => void) {
		let set = listeners.get(channel);
		if (!set) listeners.set(channel, (set = new Set()));
		set.add(listener);
		return () => set!.delete(listener);
	},
};
