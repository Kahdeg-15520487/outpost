import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { config, resolveSecret, type ProviderConfig } from "../config.ts";

/**
 * Where a provider's key comes from, highest priority first:
 *   1. outpost.config.json  models.providers.<id>.apiKey  (literal or $ENV_VAR) — read-only from the UI
 *   2. keys entered in Settings, or an OAuth sign-in (GitHub Copilot), stored in data/credentials.enc.json (AES-256-GCM)
 *   3. the provider's standard env vars (ANTHROPIC_API_KEY, …), resolved by pi-ai — unless models.ambientEnv is false
 * `env` settings (base URLs, account ids) from the config are merged over stored ones.
 */

type Sealed = { v: 1; iv: string; tag: string; data: string };

/** One JSON object of credentials, encrypted as a whole with the instance secret. */
export class EncryptedFileStore<T = Credential> {
	constructor(
		readonly path: string,
		readonly key: Buffer,
	) {}
	load(): Record<string, T> {
		if (!existsSync(this.path)) return {};
		const sealed: Sealed = JSON.parse(readFileSync(this.path, "utf8"));
		const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.iv, "base64"));
		decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
		try {
			return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8"));
		} catch {
			throw new Error(`Cannot decrypt ${this.path}: the instance secret (data/secret.key or OUTPOST_SECRET) changed`);
		}
	}
	save(all: Record<string, T>) {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		const data = Buffer.concat([cipher.update(JSON.stringify(all), "utf8"), cipher.final()]);
		const sealed: Sealed = { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
		const tmp = `${this.path}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify(sealed), { mode: 0o600 });
		renameSync(tmp, this.path);
	}
}

export class ConfigManagedError extends Error {}

function fromConfig(entry: ProviderConfig | undefined) {
	if (!entry) return undefined;
	const key = resolveSecret(entry.apiKey);
	const env: Record<string, string> = {};
	for (const [name, raw] of Object.entries(entry.env ?? {})) {
		const v = resolveSecret(raw).value;
		if (v !== undefined) env[name] = v;
	}
	return { key: key.value, keyFrom: key.from, env };
}

export class OutpostCredentialStore implements CredentialStore {
	readonly #file = new EncryptedFileStore(config.credentialsFile, config.secret);
	#chain: Promise<unknown> = Promise.resolve();

	/** The config file sets this provider's key (so the UI must not change it). */
	managedByConfig(providerId: string): string | undefined {
		const c = fromConfig(config.providers[providerId]);
		return c?.key !== undefined ? `outpost.config.json (${c.keyFrom === "literal" ? "literal key" : c.keyFrom})` : undefined;
	}

	stored(providerId: string): boolean {
		return this.#file.load()[providerId] !== undefined;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const c = fromConfig(config.providers[providerId]);
		const stored = this.#file.load()[providerId];
		// A signed-in (OAuth) provider keeps its credential unless the config file supplies a key.
		if (stored?.type === "oauth" && c?.key === undefined) return stored;
		const storedApi = stored?.type === "api_key" ? stored : undefined;
		const key = c?.key ?? storedApi?.key;
		const env = { ...storedApi?.env, ...c?.env };
		if (key === undefined && Object.keys(env).length === 0) return stored;
		return { type: "api_key", ...(key !== undefined ? { key } : {}), ...(Object.keys(env).length ? { env } : {}) };
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const all = this.#file.load();
		const ids = new Set([...Object.keys(all), ...Object.keys(config.providers).filter((id) => fromConfig(config.providers[id])?.key)]);
		return [...ids].map((providerId) => ({ providerId, type: fromConfig(config.providers[providerId])?.key === undefined && all[providerId]?.type === "oauth" ? ("oauth" as const) : ("api_key" as const) }));
	}

	/** The stored OAuth credential, if this provider is signed in (not via the config file). */
	oauth(providerId: string) {
		if (this.managedByConfig(providerId)) return undefined;
		const stored = this.#file.load()[providerId];
		return stored?.type === "oauth" ? stored : undefined;
	}

	modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
		return this.#serialize(async () => {
			const managed = this.managedByConfig(providerId);
			if (managed) throw new ConfigManagedError(`The ${providerId} key is set in ${managed}; change it there.`);
			const all = this.#file.load();
			const next = await fn(all[providerId]);
			if (next === undefined) return all[providerId];
			all[providerId] = next;
			this.#file.save(all);
			return next;
		});
	}

	delete(providerId: string) {
		return this.#serialize(async () => {
			const all = this.#file.load();
			delete all[providerId];
			this.#file.save(all);
		});
	}

	#serialize<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#chain.then(work, work);
		this.#chain = run.catch(() => {});
		return run;
	}
}
