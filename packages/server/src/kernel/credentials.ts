import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * A CredentialStore over a pi-style `auth.json` (`{ [providerId]: Credential }`).
 * Writes are serialized per provider in-process and written atomically. Re-reads the file on
 * every read so a `pi /login` done in another terminal shows up without a restart.
 */
export class FileCredentialStore implements CredentialStore {
	#chains = new Map<string, Promise<unknown>>();
	constructor(readonly path: string) {}

	#load(): Record<string, Credential> {
		if (!existsSync(this.path)) return {};
		try {
			return JSON.parse(readFileSync(this.path, "utf8"));
		} catch {
			return {};
		}
	}
	#save(all: Record<string, Credential>) {
		const tmp = `${this.path}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
		renameSync(tmp, this.path);
	}
	#enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(id) ?? Promise.resolve();
		const next = previous.then(work, work);
		this.#chains.set(id, next.catch(() => {}));
		return next;
	}

	async read(providerId: string) {
		return this.#load()[providerId];
	}
	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.#load()).map(([providerId, c]) => ({ providerId, type: c.type }));
	}
	modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
		return this.#enqueue(providerId, async () => {
			const next = await fn(this.#load()[providerId]);
			if (next === undefined) return this.#load()[providerId];
			const all = this.#load();
			all[providerId] = next;
			this.#save(all);
			return next;
		});
	}
	delete(providerId: string) {
		return this.#enqueue(providerId, async () => {
			const all = this.#load();
			delete all[providerId];
			this.#save(all);
		});
	}
}
