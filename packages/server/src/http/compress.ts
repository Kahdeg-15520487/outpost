/**
 * Compression for what we serve.
 *
 * The web app is a 560 kB bundle of JavaScript and 100 kB of CSS, and the server sent both raw: the
 * build reports gzip sizes, but nothing on the wire was compressed. A LAN instance survives that; a
 * laptop over a VPN does not. Assets are content-hashed and immutable, so a compressed copy is
 * computed once and reused until the file changes.
 *
 * Only text is compressed: woff2, png, zip and friends are already compressed and would only get
 * bigger.
 */

import { readFileSync, statSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Below this it isn't worth a compression header (and some clients dislike tiny encoded bodies). */
export const MIN_BYTES = 1_024;

export function compressible(mime: string, size: number): boolean {
	if (size < MIN_BYTES) return false;
	return /^(text\/|application\/(javascript|json|xml|x-www-form-urlencoded)|image\/svg\+xml)/.test(mime);
}

/** Which encoding to use for this request: brotli when offered, then gzip. */
export function pickEncoding(accept: string | undefined): "br" | "gzip" | undefined {
	if (!accept) return undefined;
	const quality = (name: string) => {
		const match = new RegExp(`(?:^|,)\\s*${name}\\s*(?:;\\s*q=([0-9.]+))?`, "i").exec(accept);
		if (!match) return 0;
		return match[1] === undefined ? 1 : Number(match[1]);
	};
	if (quality("br") > 0) return "br";
	if (quality("gzip") > 0) return "gzip";
	return undefined;
}

type Entry = { mtimeMs: number; size: number; br?: Buffer; gzip?: Buffer };
const cache = new Map<string, Entry>();
let cachedBytes = 0;
const MAX_CACHE = 48 << 20;

/**
 * Compressed bytes for a file, cached by mtime and size. Content-hashed asset names never change
 * content, so in practice each asset is compressed once per process.
 */
export function encodedFile(path: string, encoding: "br" | "gzip"): Buffer {
	const { mtimeMs, size } = statSync(path);
	const hit = cache.get(path);
	if (hit && hit.mtimeMs === mtimeMs && hit.size === size && hit[encoding]) return hit[encoding]!;
	const raw = readFileSync(path);
	const entry: Entry = hit && hit.mtimeMs === mtimeMs && hit.size === size ? hit : { mtimeMs, size };
	entry[encoding] = encoding === "br" ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) : gzipSync(raw, { level: 9 });
	if (hit) cachedBytes -= (hit.br?.length ?? 0) + (hit.gzip?.length ?? 0);
	entry.br ??= undefined;
	entry.gzip ??= undefined;
	cachedBytes += (entry.br?.length ?? 0) + (entry.gzip?.length ?? 0);
	cache.set(path, entry);
	// Never grow without bound, even if someone ships a folder of huge files.
	if (cachedBytes > MAX_CACHE) {
		for (const [key] of cache) {
			if (key === path) continue;
			const old = cache.get(key)!;
			cachedBytes -= (old.br?.length ?? 0) + (old.gzip?.length ?? 0);
			cache.delete(key);
			if (cachedBytes <= MAX_CACHE / 2) break;
		}
	}
	return entry[encoding]!;
}

/** Compress a JSON body for a response, when the client asked for it and it is worth doing. */
export function encodeBody(body: string, accept: string | undefined): { body: Buffer | string; encoding?: "br" | "gzip" } {
	if (Buffer.byteLength(body) < MIN_BYTES) return { body };
	const encoding = pickEncoding(accept);
	if (!encoding) return { body };
	return { body: encoding === "br" ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : gzipSync(body, { level: 6 }), encoding };
}
