/**
 * PDF via pdf.js (vendored, loaded on first use): page-by-page text with real coordinates and
 * fonts, page geometry, plus the images pulled straight out of the raw object streams so a
 * later generator can reuse them.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { encodePng } from "./png.ts";
import type { ParsedImage, ParsedPages, ParsedPage, TextItem } from "./model.ts";

const VENDOR = new URL("../../../vendor/pdfjs/", import.meta.url);
const MAX_PAGES = 400;
const MAX_ITEMS_PER_PAGE = 30_000;

type PdfJs = {
	GlobalWorkerOptions: { workerSrc: string };
	getDocument: (opts: Record<string, unknown>) => { promise: Promise<PdfDocument> };
};
type PdfDocument = {
	numPages: number;
	getPage: (n: number) => Promise<PdfPage>;
	getMetadata?: () => Promise<{ info?: Record<string, unknown>; metadata?: { get: (k: string) => unknown } }>;
	destroy?: () => Promise<void>;
};
type PdfPage = {
	getViewport: (opts: { scale: number }) => { width: number; height: number };
	rotate?: number;
	getTextContent: () => Promise<{ items: { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string; hasEOL?: boolean }[] }>;
	cleanup?: () => void;
};

let pdfjsPromise: Promise<PdfJs> | undefined;
/** Loaded on first use and kept for the process lifetime. */
export function loadPdfJs(): Promise<PdfJs> {
	pdfjsPromise ??= import(pathToFileURL(new URL("pdf.min.mjs", VENDOR).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href)
		.then((mod: unknown) => {
			const pdfjs = (mod as { default?: PdfJs }).default ?? (mod as PdfJs);
			pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(new URL("pdf.worker.min.mjs", VENDOR).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href;
			return pdfjs;
		})
		.catch((error: Error) => {
			pdfjsPromise = undefined;
			throw new Error(`pdf.js could not be loaded: ${error.message}`);
		});
	return pdfjsPromise;
}

export async function parsePdf(data: Buffer, name: string, size: number): Promise<ParsedPages> {
	const pdfjs = await loadPdfJs();
	const notes: string[] = [];
	const doc = await pdfjs.getDocument({ data: new Uint8Array(data), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
	const pages: ParsedPage[] = [];
	let words = 0;
	try {
		const count = Math.min(doc.numPages, MAX_PAGES);
		if (doc.numPages > count) notes.push(`only the first ${count} of ${doc.numPages} pages were parsed`);
		for (let i = 1; i <= count; i++) {
			const page = await doc.getPage(i);
			const viewport = page.getViewport({ scale: 1 });
			const content = await page.getTextContent();
			const items: TextItem[] = [];
			for (const item of content.items) {
				if (!item.str || !item.transform) continue;
				if (items.length >= MAX_ITEMS_PER_PAGE) {
					notes.push(`page ${i}: text items capped at ${MAX_ITEMS_PER_PAGE}`);
					break;
				}
				items.push({
					str: item.str,
					x: round(item.transform[4]),
					y: round(item.transform[5]),
					...(item.width ? { width: round(item.width) } : {}),
					...(item.height ? { height: round(item.height) } : {}),
					...(item.fontName ? { font: item.fontName } : {}),
					...(item.transform[3] ? { size: round(Math.abs(item.transform[3])) } : {}),
				});
			}
			const text = layoutText(items);
			words += (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) ?? []).length;
			pages.push({ index: i, width: round(viewport.width), height: round(viewport.height), ...(page.rotate ? { rotation: page.rotate } : {}), text, items });
			page.cleanup?.();
		}
	} finally {
		await doc.destroy?.().catch(() => undefined);
	}

	const images = extractImages(data);
	if (images.length) notes.push(`${images.length} embedded images extracted`);

	return {
		kind: "pages",
		format: "pdf",
		name,
		size,
		engine: "pdf.js",
		pages,
		images,
		stats: { pages: pages.length, words, images: images.length },
		...(notes.length ? { notes } : {}),
	};
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Group text items into lines by baseline, then lines into a reading-order string.
 * Wide gaps become spaces, big vertical gaps become blank lines.
 */
function layoutText(items: TextItem[]): string {
	if (!items.length) return "";
	const sorted = [...items].sort((a, b) => (Math.abs(a.y - b.y) > 3 ? b.y - a.y : a.x - b.x));
	const lines: { y: number; items: TextItem[] }[] = [];
	for (const item of sorted) {
		const line = lines.find((l) => Math.abs(l.y - item.y) <= 3);
		if (line) {
			line.items.push(item);
			line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
		} else lines.push({ y: item.y, items: [item] });
	}
	lines.sort((a, b) => b.y - a.y);
	const out: string[] = [];
	let lastY: number | undefined;
	let lastSize = 12;
	for (const line of lines) {
		line.items.sort((a, b) => a.x - b.x);
		let text = "";
		let endX: number | undefined;
		for (const item of line.items) {
			const size = item.size ?? lastSize;
			if (endX !== undefined && item.x - endX > Math.max(1.2, size * 0.24) && !text.endsWith(" ") && !item.str.startsWith(" ")) text += " ";
			text += item.str;
			endX = item.x + (item.width ?? 0);
			lastSize = size;
		}
		if (lastY !== undefined && lastY - line.y > lastSize * 2.2) out.push("");
		out.push(text.replace(/\s+$/g, ""));
		lastY = line.y;
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- raw image extraction

const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 12 << 20;

/** Walk the raw bytes for `/Subtype /Image` streams and decode the ones we can do losslessly. */
export function extractImages(data: Buffer): ParsedImage[] {
	const images: ParsedImage[] = [];
	const haystack = data.toString("latin1");
	let from = 0;
	while (images.length < MAX_IMAGES) {
		const marker = haystack.indexOf("/Subtype", from);
		if (marker < 0) break;
		from = marker + 8;
		if (!/^\/Subtype\s*\/Image\b/.test(haystack.slice(marker, marker + 40))) continue;
		const dictStart = Math.max(0, haystack.lastIndexOf("<<", marker));
		const streamIdx = haystack.indexOf("stream", marker);
		if (streamIdx < 0) break;
		const dict = haystack.slice(dictStart, streamIdx);
		let start = streamIdx + "stream".length;
		if (haystack[start] === "\r" && haystack[start + 1] === "\n") start += 2;
		else if (haystack[start] === "\n" || haystack[start] === "\r") start += 1;
		const end = haystack.indexOf("endstream", start);
		if (end < 0) break;
		let stop = end;
		if (haystack[stop - 2] === "\r") stop -= 2;
		else if (haystack[stop - 1] === "\n" || haystack[stop - 1] === "\r") stop -= 1;
		const width = Number(/(?:\/Width|W)\s+(\d+)/.exec(dict)?.[1] ?? 0);
		const height = Number(/(?:\/Height|H)\s+(\d+)/.exec(dict)?.[1] ?? 0);
		const bits = Number(/(?:\/BitsPerComponent|BPC)\s+(\d+)/.exec(dict)?.[1] ?? 8);
		const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? "";
		const hasPredictor = /\/Predictor\s+([2-9]|1[0-9])/.test(dict) || /\/DecodeParms/.test(dict) && /\/Predictor/.test(dict);
		const raw = data.subarray(start, stop);
		if (raw.length > MAX_IMAGE_BYTES) continue;
		try {
			if (/DCTDecode/.test(filter) && raw[0] === 0xff && raw[1] === 0xd8) {
				images.push({ ref: `img${images.length + 1}`, name: `page-image-${images.length + 1}.jpg`, mime: "image/jpeg", bytes: Buffer.from(raw), ...(width ? { width } : {}), ...(height ? { height } : {}) });
			} else if (/FlateDecode/.test(filter) && bits === 8 && !hasPredictor && width > 0 && height > 0) {
				const space = /\/ColorSpace\s*\/?(DeviceRGB|DeviceGray|DeviceCMYK)/.exec(dict)?.[1] ?? (/\/ICCBased/.test(dict) ? "DeviceRGB" : "");
				if (!space) continue;
				const inflated = inflateSync(raw, { maxOutputLength: MAX_IMAGE_BYTES });
				const channels = space === "DeviceGray" ? 1 : space === "DeviceCMYK" ? 4 : 3;
				if (inflated.length < width * height * channels) continue;
				const invert = /\/Decode\s*\[\s*1(?:\.0)?\s+0(?:\.0)?\s*\]/.test(dict);
				const bytes = space === "DeviceCMYK" ? cmykToRgb(inflated.subarray(0, width * height * 4)) : inflated;
				const png = encodePng(width, height, space === "DeviceGray" ? "grey" : "rgb", space === "DeviceCMYK" ? bytes : bytes.subarray(0, width * height * channels), { invert });
				images.push({ ref: `img${images.length + 1}`, name: `page-image-${images.length + 1}.png`, mime: "image/png", bytes: png, width, height });
			}
		} catch {
			// unsupported or corrupt image: skip it, the text still stands
		}
		from = end + 9;
	}
	return images;
}

function cmykToRgb(cmyk: Uint8Array): Uint8Array {
	const out = new Uint8Array((cmyk.length / 4) * 3);
	for (let i = 0, j = 0; i + 3 < cmyk.length; i += 4, j += 3) {
		const c = cmyk[i] / 255;
		const m = cmyk[i + 1] / 255;
		const y = cmyk[i + 2] / 255;
		const k = cmyk[i + 3] / 255;
		out[j] = Math.round(255 * (1 - Math.min(1, c + k)));
		out[j + 1] = Math.round(255 * (1 - Math.min(1, m + k)));
		out[j + 2] = Math.round(255 * (1 - Math.min(1, y + k)));
	}
	return out;
}

/** Only used by tests that need the vendored build path. */
export const pdfVendorPath = (file: string) => new URL(file, VENDOR).pathname;
export const readVendor = (file: string) => readFileSync(new URL(file, VENDOR));
