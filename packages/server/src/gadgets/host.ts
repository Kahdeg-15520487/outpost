import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { EvalFlags, QuickJS, type JSValueHandle } from "quickjs-wasi";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { FilesDoc, GadgetLogsDoc, GadgetSourceDoc, GadgetStateDoc, type FileMeta, type LogLine } from "../kernel/docs.ts";
import type { FileStore } from "../files/store.ts";
import { hub } from "../collab/hub.ts";

/**
 * Runs one gadget's server in its own QuickJS VM — no network, no filesystem, no ambient
 * authority. What it can touch is exactly what the host passes in `ctx`: its own durable storage,
 * broadcast to its connected clients, and the Gatekeepers it was introduced to.
 *
 * Calls are serialized (like a Durable Object). Storage writes of a call are committed to the
 * workspace's pi-durable Harness in one transaction when the call returns, and the call's
 * broadcasts are released only after that commit (an output gate). A call that throws rolls back.
 */
export type Caller = { kind: "user" | "agent"; id: string; name: string; role: "owner" | "editor" | "viewer" };
export type GadgetEnv = {
	harness: Harness;
	files: FileStore;
	name(): string;
	gatekeeper(gadgetId: string, grant: string, method: string, args: unknown, caller: Caller): Promise<unknown>;
};

const wasm = WebAssembly.compile(await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm"))));

const MEMORY_LIMIT = 64 << 20;
const CPU_SLICE_MS = 2_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_LOG_LINES = 300;
const MAX_FILE_READ = 16 << 20;

const PRELUDE = String.raw`
(() => {
  const fmt = (v) => typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  const h = globalThis.__host; delete globalThis.__host;
  const parse = (s) => s === undefined ? undefined : JSON.parse(s);
  globalThis.console = {
    log: (...a) => h.log("log", a.map(fmt).join(" ")),
    info: (...a) => h.log("log", a.map(fmt).join(" ")),
    warn: (...a) => h.log("warn", a.map(fmt).join(" ")),
    error: (...a) => h.log("error", a.map(fmt).join(" ")),
  };
  const storage = Object.freeze({
    get: (key) => parse(h.kvGet(String(key))),
    set: (key, value) => { h.kvSet(String(key), JSON.stringify(value === undefined ? null : value)); },
    delete: (key) => h.kvDelete(String(key)),
    list: (prefix = "") => parse(h.kvList(String(prefix))),
  });
  const gatekeepers = new Proxy({}, { get: (_, grant) => new Proxy({}, {
    get: (_, method) => async (args) => parse(await h.gk(String(grant), String(method), JSON.stringify(args ?? {}))),
  }) });
  const files = Object.freeze({
    list: () => parse(h.filesList()),
    info: (id) => parse(h.fileInfo(String(id))),
    text: (id, offset = 0, length) => h.fileText(String(id), offset, length ?? -1),
    bytes: (id, offset = 0, length) => h.fileBytes(String(id), offset, length ?? -1),
    write: async (name, data, mime) => parse(await h.fileWrite(String(name), data, mime ? String(mime) : "")),
  });
  globalThis.ctx = Object.freeze({
    storage,
    files,
    gatekeepers,
    broadcast: (event, data) => h.broadcast(String(event), JSON.stringify(data === undefined ? null : data)),
    get caller() { return parse(h.caller()); },
    presence: () => parse(h.presence()),
    now: () => Date.now(),
    id: () => h.id(),
  });
})();
`;

const DEFAULT_SERVER = `
// No server.js: a generic key/value server so client-only gadgets can still persist and sync.
export default class {
  static readonly = ["get", "list"];
  get(key) { return ctx.storage.get(key) ?? null; }
  list(prefix = "") { return ctx.storage.list(prefix); }
  set(key, value) { ctx.storage.set(key, value); ctx.broadcast("set", { key, value }); return true; }
  delete(key) { const had = ctx.storage.delete(key); ctx.broadcast("delete", { key }); return had; }
}`;

type Pending = { event: string; data: string }[];

export class GadgetHost {
	#vm: QuickJS | undefined;
	#instance: JSValueHandle | undefined;
	#methods: string[] = [];
	#readonly: string[] = [];
	#loadError: string | undefined;
	#revision = -1;
	#kv = new Map<string, string>();
	#dirty = new Map<string, string | undefined>();
	#broadcasts: Pending = [];
	#logs: LogLine[] = [];
	#caller: Caller | undefined;
	/** Files this gadget may read (shared with it, or written by it), refreshed per call. */
	#files = new Map<string, FileMeta>();
	#queue: Promise<unknown> = Promise.resolve();
	#sliceStart = 0;
	#starting: Promise<void> | undefined;

	constructor(
		readonly gadgetId: string,
		readonly env: GadgetEnv,
	) {}

	get channel() {
		return `gadget:${this.gadgetId}`;
	}

	/** Describe the server's RPC surface, starting it if needed. */
	async describe() {
		await this.#ensure();
		return { methods: this.#methods, readonly: this.#readonly, error: this.#loadError };
	}

	/** Invoke an RPC method as `caller`. Serialized with every other call to this gadget. */
	call(method: string, args: unknown[], caller: Caller): Promise<unknown> {
		const run = this.#queue.then(() => this.#call(method, args, caller));
		this.#queue = run.catch(() => {});
		return run;
	}

	/** Forget the running VM; the next call loads the current source. */
	reload() {
		this.#queue = this.#queue.then(() => this.#dispose());
		hub.publish(this.channel, { t: "gadget.reload", gadgetId: this.gadgetId });
	}

	dispose() {
		return (this.#queue = this.#queue.then(() => this.#dispose()));
	}

	#dispose() {
		this.#instance?.dispose();
		this.#vm?.dispose();
		this.#instance = this.#vm = this.#starting = undefined;
		this.#revision = -1;
	}

	async #ensure() {
		const source = await this.env.harness.snapshot(GadgetSourceDoc, this.gadgetId, ctx);
		const revision = source?.revision ?? 0;
		if (this.#vm && revision === this.#revision) return;
		if (!this.#starting) this.#starting = this.#start(source?.files ?? {}, revision).finally(() => (this.#starting = undefined));
		await this.#starting;
	}

	async #start(files: Readonly<Record<string, string>>, revision: number) {
		this.#dispose();
		this.#revision = revision;
		this.#loadError = undefined;
		this.#methods = [];
		this.#readonly = [];
		const state = await this.env.harness.snapshot(GadgetStateDoc, this.gadgetId, ctx);
		this.#kv = new Map(Object.entries(state?.kv ?? {}).map(([k, v]) => [k, JSON.stringify(v)]));

		const vm = await QuickJS.create({
			wasm: await wasm,
			memoryLimit: MEMORY_LIMIT,
			interruptHandler: () => this.#sliceStart > 0 && Date.now() - this.#sliceStart > CPU_SLICE_MS,
			moduleLoader: {
				normalize: (base, spec) => (spec.startsWith(".") ? posix.normalize(posix.join(posix.dirname(base), spec)) : spec),
				load: (name) => {
					const src = files[name] ?? files[name.replace(/^\//, "")];
					if (src === undefined) throw new Error(`Module not found: ${name}`);
					return src;
				},
			},
		});
		this.#vm = vm;
		this.#installHost(vm);
		try {
			this.#slice(() => vm.evalCode(PRELUDE, "prelude.js").dispose());
			const entry = files["server.js"] !== undefined ? "server.js" : files["server/index.js"] !== undefined ? "server/index.js" : undefined;
			const promise = this.#slice(() => vm.evalCode(entry ? files[entry]! : DEFAULT_SERVER, entry ?? "default-server.js", EvalFlags.TYPE_MODULE));
			vm.executePendingJobs();
			const loaded = await vm.resolvePromise(promise);
			promise.dispose();
			if ("error" in loaded) throw new Error(loaded.error.consume((e) => this.#errorText(e)));
			using ns = loaded.value;
			using exported = ns.getProp("default");
			using make = vm.evalCode(`(E) => {
				const inst = typeof E === "function" ? new E(ctx) : (E ?? {});
				const names = new Set();
				for (let o = inst; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
					for (const n of Object.getOwnPropertyNames(o)) if (n !== "constructor" && !n.startsWith("_") && typeof inst[n] === "function") names.add(n);
				const ro = (typeof E === "function" ? E.readonly : inst.readonly) ?? [];
				return [inst, JSON.stringify({ methods: [...names], readonly: ro })];
			}`);
			using pair = this.#slice(() => vm.callFunction(make, vm.undefined, exported));
			this.#instance = pair.getProp("0");
			const meta = JSON.parse(pair.getProp("1").consume((h) => h.toString()));
			this.#methods = meta.methods;
			this.#readonly = meta.readonly;
		} catch (error) {
			this.#loadError = error instanceof Error ? error.message : String(error);
			this.#log("error", `Failed to start server: ${this.#loadError}`);
			await this.#flush();
		}
	}

	#slice<T>(fn: () => T): T {
		this.#sliceStart = Date.now();
		try {
			return fn();
		} finally {
			this.#sliceStart = 0;
		}
	}

	#errorText(handle: JSValueHandle): string {
		const vm = this.#vm!;
		try {
			const message = handle.getProp("message").consume((h) => vm.dump(h));
			const stack = handle.getProp("stack").consume((h) => vm.dump(h));
			if (message !== undefined) return `${message}${stack ? `\n${String(stack).trim()}` : ""}`;
		} catch {}
		return String(vm.dump(handle));
	}

	#installHost(vm: QuickJS) {
		const host = vm.newObject();
		const fn = (name: string, f: (...args: JSValueHandle[]) => JSValueHandle | undefined) => {
			using h = vm.newFunction(name, (...a) => f(...a) ?? vm.undefined);
			vm.setProp(host, name, h);
		};
		const str = (s: string | undefined) => (s === undefined ? vm.undefined : vm.newString(s));
		fn("log", (level, text) => void this.#log(level!.toString() as LogLine["level"], text!.toString()));
		fn("kvGet", (k) => str(this.#kv.get(k!.toString())));
		fn("kvSet", (k, v) => {
			const key = k!.toString();
			const value = v!.toString();
			if (key.length > 512) throw new Error("storage key too long");
			if (value.length > 1_000_000) throw new Error("storage value over 1 MB");
			this.#kv.set(key, value);
			this.#dirty.set(key, value);
		});
		fn("kvDelete", (k) => {
			const key = k!.toString();
			const had = this.#kv.delete(key);
			this.#dirty.set(key, undefined);
			return had ? vm.true : vm.false;
		});
		fn("kvList", (p) => {
			const prefix = p!.toString();
			const out: Record<string, unknown> = {};
			for (const [k, v] of this.#kv) if (k.startsWith(prefix)) out[k] = JSON.parse(v);
			return vm.newString(JSON.stringify(out));
		});
		fn("broadcast", (event, data) => void this.#broadcasts.push({ event: event!.toString(), data: data!.toString() }));
		fn("caller", () => vm.newString(JSON.stringify(this.#caller ?? null)));
		fn("presence", () => vm.newString(JSON.stringify(hub.presence(this.channel))));
		fn("id", () => vm.newString(crypto.randomUUID()));
		const fileOf = (h: JSValueHandle) => {
			const meta = this.#files.get(h.toString());
			if (!meta) throw new Error(`No access to file ${h.toString()}: ask the user (or the agent, file_share_with_gadget) to share it with this gadget`);
			return meta;
		};
		const range = (meta: FileMeta, o?: JSValueHandle, l?: JSValueHandle) => {
			const offset = Math.max(0, o?.toNumber() || 0);
			const want = l?.toNumber() ?? -1;
			const length = Math.min(want < 0 ? meta.size - offset : want, MAX_FILE_READ);
			if (want < 0 && meta.size - offset > MAX_FILE_READ) throw new Error(`File is ${meta.size} bytes; read it in ranges of at most ${MAX_FILE_READ} (offset, length)`);
			return [offset, length] as const;
		};
		const pub = (m: FileMeta) => ({ id: m.id, name: m.name, mime: m.mime, kind: m.kind, size: m.size, createdAt: m.createdAt });
		fn("filesList", () => vm.newString(JSON.stringify([...this.#files.values()].map(pub))));
		fn("fileInfo", (id) => vm.newString(JSON.stringify(pub(fileOf(id!)))));
		fn("fileText", (id, o, l) => {
			const meta = fileOf(id!);
			return vm.newString(this.env.files.bytes(meta, ...range(meta, o, l)).toString("utf8"));
		});
		fn("fileBytes", (id, o, l) => {
			const meta = fileOf(id!);
			return vm.newUint8Array(new Uint8Array(this.env.files.bytes(meta, ...range(meta, o, l))));
		});
		fn("fileWrite", (name, data, mime) => {
			const deferred = vm.newPromise();
			const bytes = data!.typeof === "string" ? Buffer.from(data!.toString(), "utf8") : Buffer.from(data!.toUint8Array());
			const caller = this.#caller;
			this.env.files
				.put(bytes, { name: name!.toString(), mime: mime!.toString() || undefined, createdBy: `${this.env.name()} (${caller?.name ?? "gadget"})`, source: "gadget", gadgets: [this.gadgetId] })
				.then(
					(meta) => {
						this.#files.set(meta.id, meta);
						deferred.resolve(vm.newString(JSON.stringify(pub(meta))));
					},
					(error) => deferred.reject(vm.newError(error instanceof Error ? error.message : String(error))),
				)
				.finally(() => this.#vm === vm && this.#slice(() => vm.executePendingJobs()));
			return deferred.handle;
		});
		fn("gk", (grant, method, args) => {
			const deferred = vm.newPromise();
			const caller = this.#caller!;
			this.env
				.gatekeeper(this.gadgetId, grant!.toString(), method!.toString(), JSON.parse(args!.toString()), caller)
				.then(
					(result) => deferred.resolve(vm.newString(JSON.stringify(result ?? null))),
					(error) => deferred.reject(vm.newError(error instanceof Error ? error.message : String(error))),
				)
				.finally(() => this.#vm === vm && this.#slice(() => vm.executePendingJobs()));
			return deferred.handle;
		});
		vm.setProp(vm.global, "__host", host);
		host.dispose();
	}

	async #call(method: string, args: unknown[], caller: Caller): Promise<unknown> {
		await this.#ensure();
		if (this.#loadError) throw new Error(`Gadget server failed to start: ${this.#loadError}`);
		if (!this.#methods.includes(method)) throw new Error(`No such method: ${method}. Available: ${this.#methods.join(", ") || "(none)"}`);
		if (caller.role === "viewer" && !this.#readonly.includes(method)) throw new Error(`Viewers may only call: ${this.#readonly.join(", ") || "(nothing)"}`);
		const vm = this.#vm!;
		const kvBefore = new Map(this.#kv);
		const allFiles = (await this.env.harness.snapshot(FilesDoc, ctx))?.files ?? {};
		this.#files = new Map(Object.values(allFiles).filter((f) => f.gadgets.includes(this.gadgetId)).map((f) => [f.id, f]));
		this.#caller = caller;
		this.#dirty.clear();
		this.#broadcasts = [];
		const started = Date.now();
		try {
			const result = await Promise.race([
				(async () => {
					using fn = this.#instance!.getProp(method);
					const handles = args.map((a) => vm.hostToHandle(a === undefined ? null : JSON.parse(JSON.stringify(a))));
					const out = this.#slice(() => vm.callFunction(fn, this.#instance!, ...handles));
					for (const h of handles) h.dispose();
					this.#slice(() => vm.executePendingJobs());
					const settled = await vm.resolvePromise(out);
					out.dispose();
					if ("error" in settled) throw new Error(settled.error.consume((e) => this.#errorText(e)));
					return settled.value.consume((v) => vm.dump(v));
				})(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`call timed out after ${CALL_TIMEOUT_MS / 1000}s`)), CALL_TIMEOUT_MS)),
			]);
			if (this.#dirty.size) this.#log("call", `${caller.name} → ${method}(${JSON.stringify(args).slice(1, -1).slice(0, 200)}) ${Date.now() - started}ms`);
			await this.#flush();
			return result;
		} catch (error) {
			// Roll back this call's writes and drop its broadcasts.
			this.#kv = kvBefore;
			this.#dirty.clear();
			this.#broadcasts = [];
			const text = error instanceof Error ? error.message : String(error);
			this.#log("error", `${caller.name} → ${method} threw: ${text}`);
			await this.#flush();
			if (/interrupted|out of memory/i.test(text)) this.#dispose(); // a wedged VM is not reused
			throw new Error(text);
		} finally {
			this.#caller = undefined;
		}
	}

	#log(level: LogLine["level"], text: string) {
		const line = { at: Date.now(), level, text: text.slice(0, 4000) };
		this.#logs.push(line);
		hub.publish(this.channel, { t: "gadget.log", gadgetId: this.gadgetId, line });
	}

	/** Commit storage writes (with any buffered logs) in one transaction, then release broadcasts. Log-only flushes are batched. */
	async #flush() {
		const dirty = [...this.#dirty];
		const broadcasts = this.#broadcasts.splice(0);
		this.#dirty.clear();
		if (dirty.length) await this.#commit(dirty);
		else if (this.#logs.length && !this.#logTimer) this.#logTimer = setTimeout(() => void this.#commit([]).catch(() => {}), 1500);
		for (const b of broadcasts) hub.publish(this.channel, { t: "gadget.event", gadgetId: this.gadgetId, event: b.event, data: JSON.parse(b.data) });
	}

	#logTimer: ReturnType<typeof setTimeout> | undefined;
	async #commit(dirty: [string, string | undefined][]) {
		clearTimeout(this.#logTimer);
		this.#logTimer = undefined;
		const logs = this.#logs.splice(0);
		if (!dirty.length && !logs.length) return;
		await this.env.harness.commit(async (tx) => {
				if (dirty.length) {
					const state = await tx.doc(GadgetStateDoc, this.gadgetId, null);
					for (const [k, v] of dirty) {
						if (v === undefined) delete state.kv[k];
						else state.kv[k] = JSON.parse(v);
					}
				}
				if (logs.length) {
					const doc = await tx.doc(GadgetLogsDoc, this.gadgetId, null);
					doc.lines.push(...logs);
					if (doc.lines.length > MAX_LOG_LINES) doc.lines.splice(0, doc.lines.length - MAX_LOG_LINES);
				}
		}, ctx);
	}
}
