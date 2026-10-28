import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { FilesDoc, type FileMeta } from "../kernel/docs.ts";

/**
 * Workspace files: bytes content-addressed on disk (`<ws>.files/<sha256>`), index in the durable
 * FilesDoc. The store offers format-agnostic primitives — sniff, read ranges, search, unzip,
 * inflate, image preparation — so the agent can take apart formats it has never seen.
 */

let images: Promise<ImageProcessor | undefined> | undefined;
export const imageProcessor = () => (images ??= createNodePhotonImages().catch((e) => (console.warn("outpost: image processor unavailable:", e.message), undefined)));

const MIME_BY_EXT: Record<string, string> = {
	txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", xml: "application/xml", html: "text/html", htm: "text/html",
	js: "text/javascript", ts: "text/typescript", py: "text/x-python", yaml: "application/yaml", yml: "application/yaml", log: "text/plain", svg: "image/svg+xml",
	pdf: "application/pdf", zip: "application/zip", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", gz: "application/gzip", sqlite: "application/vnd.sqlite3", db: "application/vnd.sqlite3",
};
const ext = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
export const mimeFor = (name: string, given?: string) => (given && given !== "application/octet-stream" ? given : (MIME_BY_EXT[ext(name)] ?? "application/octet-stream"));

/** Identify a file from its first bytes (and name, to refine containers). */
export function sniff(head: Buffer, name: string): string {
	const s = (a: number, b: number) => head.subarray(a, b).toString("latin1");
	const hex = head.subarray(0, 8).toString("hex");
	const e = ext(name);
	if (s(0, 5) === "%PDF-") return "pdf";
	if (hex.startsWith("504b0304") || hex.startsWith("504b0506")) return ["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "jar", "apk", "vsix", "whl", "ipa"].includes(e) ? e : "zip";
	if (hex.startsWith("89504e47")) return "png";
	if (hex.startsWith("ffd8ff")) return "jpeg";
	if (s(0, 4) === "GIF8") return "gif";
	if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return "webp";
	if (s(0, 4) === "RIFF" && s(8, 12) === "WAVE") return "wav";
	if (s(0, 2) === "BM") return "bmp";
	if (hex.startsWith("1f8b")) return "gzip";
	if (s(0, 16) === "SQLite format 3\0") return "sqlite";
	if (hex.startsWith("377abcaf271c")) return "7z";
	if (s(0, 4) === "Rar!") return "rar";
	if (hex.startsWith("d0cf11e0a1b11ae1")) return "ole2 (legacy doc/xls/ppt/msg)";
	if (s(4, 8) === "ftyp") return "mp4/mov";
	if (s(0, 3) === "ID3" || hex.startsWith("fffb") || hex.startsWith("fff3")) return "mp3";
	if (s(0, 4) === "OggS") return "ogg";
	if (s(0, 4) === "fLaC") return "flac";
	if (hex.startsWith("7f454c46")) return "elf";
	if (s(0, 2) === "MZ") return "exe/dll";
	if (s(0, 5) === "{\\rtf") return "rtf";
	if (s(0, 4) === "%!PS") return "postscript";
	if (hex.startsWith("0061736d")) return "wasm";
	if (looksLikeText(head)) {
		const t = head.toString("utf8").trimStart();
		if (e === "csv" || e === "tsv") return e;
		if (/^[[{]/.test(t) && ["json", "geojson", ""].includes(e)) return "json";
		if (t.startsWith("<?xml") || e === "xml") return "xml";
		if (/^<!doctype html|^<html/i.test(t)) return "html";
		if (t.startsWith("<svg") || e === "svg") return "svg";
		return e ? `text (.${e})` : "text";
	}
	return "binary";
}

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

export function looksLikeText(buf: Buffer): boolean {
	if (!buf.length) return true;
	const sample = buf.subarray(0, 8192);
	let control = 0;
	for (const b of sample) if (b === 0) return false;
	else if (b < 9 || (b > 13 && b < 32)) control++;
	if (control / sample.length > 0.02) return false;
	// Valid UTF-8 (allowing a cut multi-byte sequence at the end)?
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
		return true;
	} catch {
		return false;
	}
}

export function hexdump(buf: Buffer, base = 0): string {
	const lines: string[] = [];
	for (let i = 0; i < buf.length; i += 16) {
		const row = buf.subarray(i, i + 16);
		const hexes = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
		const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
		lines.push(`${(base + i).toString(16).padStart(8, "0")}  ${hexes.padEnd(47)}  ${ascii}`);
	}
	return lines.join("\n");
}

export type ZipEntry = { name: string; method: number; compressedSize: number; size: number; localOffset: number };

/** Minimal ZIP reader (stored + deflate; no zip64, no encryption). Enough for OOXML/ODF/EPUB/JAR. */
export function zipEntries(data: Buffer): ZipEntry[] {
	const min = Math.max(0, data.length - 65_557);
	let eocd = -1;
	for (let i = data.length - 22; i >= min; i--) if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	if (eocd < 0) throw new Error("Not a zip archive (no end-of-central-directory record)");
	const count = data.readUInt16LE(eocd + 10);
	let p = data.readUInt32LE(eocd + 16);
	if (p === 0xffffffff) throw new Error("zip64 archives are not supported");
	const entries: ZipEntry[] = [];
	for (let i = 0; i < count; i++) {
		if (data.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt central directory");
		const nameLen = data.readUInt16LE(p + 28);
		const extraLen = data.readUInt16LE(p + 30);
		const commentLen = data.readUInt16LE(p + 32);
		entries.push({
			method: data.readUInt16LE(p + 10),
			compressedSize: data.readUInt32LE(p + 20),
			size: data.readUInt32LE(p + 24),
			localOffset: data.readUInt32LE(p + 42),
			name: data.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
		});
		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

export function zipRead(data: Buffer, entry: ZipEntry): Buffer {
	const p = entry.localOffset;
	if (data.readUInt32LE(p) !== 0x04034b50) throw new Error(`Corrupt local header for ${entry.name}`);
	const start = p + 30 + data.readUInt16LE(p + 26) + data.readUInt16LE(p + 28);
	const raw = data.subarray(start, start + entry.compressedSize);
	if (entry.method === 0) return Buffer.from(raw);
	if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: 256 << 20 });
	throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
}

export type InflateFormat = "auto" | "zlib" | "deflate-raw" | "gzip";
export function inflate(buf: Buffer, format: InflateFormat): { out: Buffer; format: string } {
	const opts = { maxOutputLength: 256 << 20 };
	const tries: [string, () => Buffer][] = [
		["gzip", () => gunzipSync(buf, opts)],
		["zlib", () => inflateSync(buf, opts)],
		["deflate-raw", () => inflateRawSync(buf, opts)],
	];
	const order = format === "auto" ? tries : tries.filter(([f]) => f === format);
	let last: unknown;
	for (const [f, run] of order) {
		try {
			return { out: run(), format: f };
		} catch (error) {
			last = error;
		}
	}
	throw new Error(`Could not decompress (${format}): ${(last as Error)?.message}`);
}

export class FileStore {
	readonly dir: string;
	constructor(
		readonly harness: Harness,
		workspaceDir: string,
		workspaceId: string,
	) {
		this.dir = join(workspaceDir, `${workspaceId}.files`);
		mkdirSync(this.dir, { recursive: true });
	}

	#path(sha: string) {
		return join(this.dir, sha);
	}

	async list(): Promise<FileMeta[]> {
		return Object.values((await this.harness.snapshot(FilesDoc, ctx))?.files ?? {}).sort((a, b) => b.createdAt - a.createdAt);
	}

	async get(ref: string): Promise<FileMeta> {
		const files = (await this.harness.snapshot(FilesDoc, ctx))?.files ?? {};
		const meta = files[ref] ?? Object.values(files).find((f) => f.name === ref);
		if (!meta) throw new Error(`No file "${ref}". Use file_list.`);
		return meta;
	}

	async put(bytes: Buffer, init: { name: string; mime?: string; createdBy: string; source: FileMeta["source"]; parent?: string; chatId?: string; modules?: string[] }): Promise<FileMeta> {
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (!existsSync(this.#path(sha256))) writeFileSync(this.#path(sha256), bytes);
		const name = init.name.replace(/[\\\0]/g, "_").slice(0, 240) || "untitled";
		const meta: FileMeta = {
			id: `f_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
			name,
			mime: mimeFor(name, init.mime),
			size: bytes.length,
			sha256,
			kind: sniff(bytes.subarray(0, 8192), name),
			createdAt: Date.now(),
			createdBy: init.createdBy,
			source: init.source,
			...(init.parent ? { parent: init.parent } : {}),
			...(init.chatId ? { chatId: init.chatId } : {}),
			modules: init.modules ?? [],
		};
		await this.harness.commit(async (tx) => {
			(await tx.doc(FilesDoc)).files[meta.id] = meta;
		}, ctx);
		return meta;
	}

	bytes(meta: FileMeta, offset = 0, length = meta.size - offset): Buffer {
		const start = Math.max(0, Math.min(offset, meta.size));
		const len = Math.max(0, Math.min(length, meta.size - start));
		const out = Buffer.alloc(len);
		const fd = openSync(this.#path(meta.sha256), "r");
		try {
			readSync(fd, out, 0, len, start);
		} finally {
			closeSync(fd);
		}
		return out;
	}

	all(meta: FileMeta): Buffer {
		return readFileSync(this.#path(meta.sha256));
	}

	async update(id: string, patch: (meta: FileMeta) => void) {
		await this.harness.commit(async (tx) => {
			const f = (await tx.doc(FilesDoc)).files[id];
			if (f) patch(f);
		}, ctx);
	}

	async delete(id: string) {
		let sha: string | undefined;
		let stillUsed = false;
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(FilesDoc);
			sha = doc.files[id]?.sha256;
			delete doc.files[id];
			// Derived files outlive their source, but the link to a file that no longer exists is a lie:
			// drop it, so they list at the top level instead of hanging under nothing.
			for (const file of Object.values(doc.files)) if (file.parent === id) delete file.parent;
			stillUsed = Object.values(doc.files).some((f) => f.sha256 === sha);
		}, ctx);
		if (sha && !stillUsed && existsSync(this.#path(sha))) rmSync(this.#path(sha));
	}

	/**
	 * Rewrite a file's bytes in place, keeping its id, name, shares and place in the chat.
	 * Used when the reader edits the file itself (ticking a checkbox in a Markdown checklist).
	 */
	async replaceText(id: string, bytes: Buffer): Promise<FileMeta> {
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (!existsSync(this.#path(sha256))) writeFileSync(this.#path(sha256), bytes);
		let old: string | undefined;
		let meta: FileMeta | undefined;
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(FilesDoc);
			const file = doc.files[id];
			if (!file) return;
			old = file.sha256;
			file.sha256 = sha256;
			file.size = bytes.length;
			file.kind = sniff(bytes.subarray(0, 8192), file.name);
			meta = { ...file };
		}, ctx);
		if (!meta) throw new Error(`No file "${id}"`);
		if (old && old !== sha256) {
			const stillUsed = (await this.harness.snapshot(FilesDoc, ctx))?.files;
			if (!Object.values(stillUsed ?? {}).some((f) => f.sha256 === old) && existsSync(this.#path(old))) rmSync(this.#path(old));
		}
		return meta;
	}

	/** Byte offsets of a text or hex pattern, from `from`, up to `max` hits. */
	search(meta: FileMeta, pattern: Buffer, from = 0, max = 50): number[] {
		const hits: number[] = [];
		const chunk = 4 << 20;
		for (let start = from; start < meta.size && hits.length < max; start += chunk - pattern.length) {
			const buf = this.bytes(meta, start, chunk);
			let i = buf.indexOf(pattern);
			while (i >= 0 && hits.length < max) {
				hits.push(start + i);
				i = buf.indexOf(pattern, i + 1);
			}
			if (buf.length < chunk) break;
		}
		return [...new Set(hits)];
	}

	/** Prepare an image for a model (resized to fit), or undefined if it isn't a supported image. */
	async image(meta: FileMeta): Promise<{ data: string; mimeType: string; note?: string } | undefined> {
		const mime = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[meta.kind];
		if (!mime || meta.size > 40 << 20) return undefined;
		const bytes = this.all(meta);
		const processor = await imageProcessor();
		if (processor) {
			const prepared = await processor.prepare(new Uint8Array(bytes), mime, DEFAULT_IMAGE_LIMITS).catch(() => undefined);
			if (!prepared) return undefined;
			const note = prepared.resized ? `resized from ${prepared.resized.from.width}x${prepared.resized.from.height} to ${prepared.resized.to.width}x${prepared.resized.to.height}` : undefined;
			return { data: prepared.data, mimeType: prepared.mimeType, note };
		}
		if (mime === "image/bmp" || bytes.length > 3_500_000) return undefined;
		return { data: bytes.toString("base64"), mimeType: mime };
	}

	stat(meta: FileMeta) {
		return existsSync(this.#path(meta.sha256)) ? statSync(this.#path(meta.sha256)).size : -1;
	}
}
