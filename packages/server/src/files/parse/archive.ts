/**
 * Archives, each through the library that actually implement it: yauzl (zip, zip64),
 * tar-stream (ustar/pax/gnu), node:zlib (gz), and the vendored WASM builds of unrar and 7-Zip.
 * Every loader is lazy and the wasm ones are instantiated once per process.
 */

import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import type { ArchiveEntry, ParsedArchive } from "./model.ts";

const VENDOR = fileURLToPath(new URL("../../../vendor/", import.meta.url));
const require = createRequire(import.meta.url);

export type ArchiveFormat = "zip" | "rar" | "7z" | "tar" | "gz";

const MAX_ENTRIES = 20_000;
const MAX_TOTAL = 256 << 20;
const MAX_ARCHIVE = 128 << 20;

export interface ExtractedEntry {
	path: string;
	bytes: Buffer;
}

// ---------------------------------------------------------------- zip (yauzl)

const openZip = (data: Buffer): Promise<ZipFile> =>
	new Promise((resolve, reject) => {
		fromBuffer(data, { lazyEntries: true, decodeStrings: true, validateEntrySizes: false }, (err, zip) => (err || !zip ? reject(err as Error) : resolve(zip)));
	});

const readEntry = (zip: ZipFile, entry: Entry): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		zip.openReadStream(entry, (err, stream) => {
			if (err || !stream) return reject(err);
			const chunks: Buffer[] = [];
			let total = 0;
			stream.on("data", (chunk: Buffer) => {
				total += chunk.length;
				if (total > MAX_TOTAL) {
					stream.destroy();
					reject(new Error(`${entry.fileName}: entry too large`));
					return;
				}
				chunks.push(chunk);
			});
			stream.on("end", () => resolve(Buffer.concat(chunks)));
			stream.on("error", reject);
		});
	});

async function walkZip(data: Buffer, onEntry: (entry: Entry, read: () => Promise<Buffer>) => Promise<"stop" | void>): Promise<void> {
	const zip = await openZip(data);
	try {
		await new Promise<void>((resolve, reject) => {
			const next = () => zip.readEntry();
			zip.on("entry", (entry: Entry) => {
				void onEntry(entry, () => readEntry(zip, entry))
					.then((action) => (action === "stop" ? resolve() : next()))
					.catch(reject);
			});
			zip.on("end", () => resolve());
			zip.on("error", reject);
			zip.readEntry();
		});
	} finally {
		zip.close();
	}
}

const zipDate = (entry: Entry): string | undefined => {
	const t = entry.getLastModDate?.();
	return t && !Number.isNaN(t.getTime()) ? t.toISOString() : undefined;
};

// ---------------------------------------------------------------- tar (tar-stream)

const loadTar = async () => (await import("tar-stream")).extract;

async function walkTar(data: Buffer, onEntry: (header: { name: string; size: number; type: string; mode?: number; mtime?: Date }, read: () => Promise<Buffer>) => Promise<"stop" | void>): Promise<void> {
	const extract = await loadTar();
	const parser = extract();
	const done = new Promise<void>((resolve, reject) => {
		parser.on("entry", (header, stream, next) => {
			const chunks: Buffer[] = [];
			stream.on("data", (c: unknown) => chunks.push(c as Buffer));
			stream.on("end", () => {
				void onEntry({ name: header.name, size: header.size, type: header.type, mode: header.mode, mtime: header.mtime }, async () => Buffer.concat(chunks))
					.then((action) => (action === "stop" ? resolve() : next()))
					.catch(reject);
			});
			stream.resume();
		});
		parser.on("finish", () => resolve());
		parser.on("error", reject);
	});
	parser.end(data);
	await done;
}

// ---------------------------------------------------------------- rar (vendored unrar wasm)

type UnrarExtractor = {
	getFileList: () => { fileHeaders: { name: string; unpSize: number; packSize?: number; flags?: { directory?: boolean; encrypted?: boolean }; time?: Date; method?: string }[] };
	extract: (opts?: { files?: string[] }) => { files: { fileHeader: { name: string; unpSize: number }; extraction?: Uint8Array }[] };
};

const unrarModule = () => require(join(VENDOR, "unrar/dist/index.js")) as { createExtractorFromData: (opts: { data: Uint8Array }) => Promise<UnrarExtractor> };

/** unrar's wasm is instantiated once per process, on first archive that needs it. */
const openRar = async (data: Uint8Array): Promise<UnrarExtractor> => unrarModule().createExtractorFromData({ data });

// ---------------------------------------------------------------- 7z (vendored 7z-wasm)

type SevenZip = { FS: { writeFile: (p: string, d: Uint8Array) => void; readFile: (p: string) => Uint8Array; readdir: (p: string) => string[]; stat: (p: string) => { isDirectory: () => boolean }; mkdir: (p: string) => void }; callMain: (args: string[]) => void };
let sevenZip: Promise<SevenZip> | undefined;

export function load7z(): Promise<SevenZip> {
	sevenZip ??= import(pathToFileURL(join(VENDOR, "7z/7zz.es6.js")).href)
		.then(async (mod: unknown) => {
			const factory = ((mod as { default?: unknown }).default ?? mod) as (opts: Record<string, unknown>) => Promise<SevenZip>;
			const out: string[] = [];
			const instance = await factory({
				locateFile: (file: string) => join(VENDOR, "7z", file),
				print: (line: string) => out.push(line),
				printErr: () => undefined,
				noExitRuntime: false,
			});
			(instance as unknown as { __out: string[] }).__out = out;
			return instance;
		})
		.catch((error: Error) => {
			sevenZip = undefined;
			throw new Error(`7-Zip wasm could not be loaded: ${error.message}`);
		});
	return sevenZip;
}

function sevenZipRun(sz: SevenZip, args: string[]): string[] {
	const out = (sz as unknown as { __out: string[] }).__out;
	out.length = 0;
	sz.callMain(args);
	return [...out];
}

function sevenZipList(sz: SevenZip, archive: Uint8Array): ArchiveEntry[] {
	sz.FS.writeFile("/a.7z", archive);
	const lines = sevenZipRun(sz, ["l", "-slt", "/a.7z"]);
	const entries: ArchiveEntry[] = [];
	let current: Partial<ArchiveEntry> | undefined;
	for (const line of lines) {
		const m = /^([A-Za-z ]+?) = (.*)$/.exec(line);
		if (!m) {
			if (current?.path) entries.push(current as ArchiveEntry);
			current = undefined;
			continue;
		}
		const key = m[1].trim();
		const value = m[2].trim();
		current ??= {};
		if (key === "Path") current.path = value;
		else if (key === "Size") current.size = Number(value);
		else if (key === "Packed Size") current.packed = Number(value);
		else if (key === "Modified") current.modified = value;
		else if (key === "Method") current.method = value;
		else if (key === "Attributes") current.dir = value.startsWith("D") || value.includes("D_");
		else if (key === "Encrypted") current.encrypted = value === "+";
	}
	if (current?.path) entries.push(current as ArchiveEntry);
	// the first block describes the archive itself
	return entries.filter((e) => e.path && e.path !== "/a.7z");
}

// ---------------------------------------------------------------- public API

export async function listArchive(format: ArchiveFormat, data: Buffer, name: string, size: number): Promise<ParsedArchive> {
	if (data.length > MAX_ARCHIVE) throw new Error("archive is larger than the 128 MB parse limit");
	const entries: ArchiveEntry[] = [];
	const notes: string[] = [];
	switch (format) {
		case "zip":
			await walkZip(data, async (entry, read) => {
				entries.push({
					path: entry.fileName,
					size: entry.uncompressedSize,
					packed: entry.compressedSize,
					method: entry.compressionMethod === 0 ? "stored" : entry.compressionMethod === 8 ? "deflate" : `method ${entry.compressionMethod}`,
					...(entry.crc32 ? { crc: (entry.crc32 >>> 0).toString(16) } : {}),
					...(zipDate(entry) ? { modified: zipDate(entry) } : {}),
					...(entry.fileName.endsWith("/") ? { dir: true } : {}),
					...(entry.isEncrypted() ? { encrypted: true } : {}),
				});
				void read;
				return entries.length >= MAX_ENTRIES ? "stop" : undefined;
			});
			break;
		case "tar":
			await walkTar(data, async (header) => {
				entries.push({ path: header.name, size: header.size, method: "tar", ...(header.mtime ? { modified: header.mtime.toISOString() } : {}), ...(header.type === "directory" ? { dir: true } : {}) });
				return entries.length >= MAX_ENTRIES ? "stop" : undefined;
			});
			break;
		case "gz": {
			const out = gunzipSync(data, { maxOutputLength: MAX_TOTAL });
			entries.push({ path: name.replace(/\.(gz|gzip)$/i, "").replace(/\.tar$/i, ".tar"), size: out.length, method: "gzip" });
			break;
		}
		case "rar": {
			const extractor = await openRar(new Uint8Array(data));
			for (const header of extractor.getFileList().fileHeaders) {
				if (entries.length >= MAX_ENTRIES) break;
				entries.push({
					path: header.name,
					size: header.unpSize,
					...(header.packSize !== undefined ? { packed: header.packSize } : {}),
					method: header.method ?? "rar",
					...(header.time ? { modified: header.time instanceof Date ? header.time.toISOString() : String(header.time) } : {}),
					...(header.flags?.directory ? { dir: true } : {}),
					...(header.flags?.encrypted ? { encrypted: true } : {}),
				});
			}
			break;
		}
		case "7z": {
			const sz = await load7z();
			const listed = sevenZipList(sz, new Uint8Array(data));
			entries.push(...listed.slice(0, MAX_ENTRIES));
			if (listed.length > MAX_ENTRIES) notes.push(`only the first ${MAX_ENTRIES} entries are listed`);
			break;
		}
	}
	if (entries.length >= MAX_ENTRIES) notes.push(`entry list capped at ${MAX_ENTRIES}`);
	const files = entries.filter((e) => !e.dir);
	return {
		kind: "archive",
		format,
		name,
		size,
		engine: format === "rar" ? "unrar wasm" : format === "7z" ? "7z wasm" : format === "zip" ? "yauzl" : "tar-stream",
		archive: format,
		entries,
		stats: { entries: entries.length, bytes: files.reduce((a, e) => a + e.size, 0), files: files.length, folders: entries.length - files.length },
		...(notes.length ? { notes } : {}),
	};
}

/** Extract entries (all, or those matching a regex), bounded by the caps above. */
export async function extractArchive(format: ArchiveFormat, data: Buffer, filter?: RegExp): Promise<ExtractedEntry[]> {
	const out: ExtractedEntry[] = [];
	let total = 0;
	const keep = (path: string) => !filter || filter.test(path);
	const add = (path: string, bytes: Buffer) => {
		if (bytes.length > MAX_TOTAL - total) throw new Error("archive expands past the 256 MB limit");
		total += bytes.length;
		out.push({ path: posix.normalize(path).replace(/^(\.\.\/)+/, ""), bytes });
	};

	switch (format) {
		case "zip":
			await walkZip(data, async (entry, read) => {
				if (entry.fileName.endsWith("/") || !keep(entry.fileName)) return;
				add(entry.fileName, await read());
				return out.length >= MAX_ENTRIES ? "stop" : undefined;
			});
			break;
		case "tar":
			await walkTar(data, async (header, read) => {
				if (header.type !== "file" || !keep(header.name)) return;
				add(header.name, await read());
				return out.length >= MAX_ENTRIES ? "stop" : undefined;
			});
			break;
		case "gz":
			add("content", gunzipSync(data, { maxOutputLength: MAX_TOTAL }));
			break;
		case "rar": {
			const extractor = await openRar(new Uint8Array(data));
			const result = extractor.extract({ files: filter ? undefined : undefined });
			for (const file of result.files) {
				if (!file.extraction || !keep(file.fileHeader.name)) continue;
				add(file.fileHeader.name, Buffer.from(file.extraction));
			}
			break;
		}
		case "7z": {
			const sz = await load7z();
			sz.FS.writeFile("/a.7z", new Uint8Array(data));
			try {
				sz.FS.mkdir("/out");
			} catch {
				/* exists */
			}
			sevenZipRun(sz, ["x", "/a.7z", "-o/out", "-y"]);
			walk7z(sz, "/out", "", (path, bytes) => {
				if (keep(path)) add(path, bytes);
			});
			break;
		}
	}
	return out;
}

function walk7z(sz: SevenZip, dir: string, prefix: string, onFile: (path: string, bytes: Buffer) => void): void {
	for (const name of sz.FS.readdir(dir)) {
		if (name === "." || name === "..") continue;
		const full = `${dir}/${name}`;
		const stat = sz.FS.stat(full);
		if (stat.isDirectory()) walk7z(sz, full, `${prefix}${name}/`, onFile);
		else onFile(`${prefix}${name}`, Buffer.from(sz.FS.readFile(full)));
	}
}

export const archiveVendorDir = () => join(dirname(VENDOR), "vendor");
