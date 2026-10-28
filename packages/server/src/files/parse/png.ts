/**
 * Minimal PNG writer: 8-bit greyscale, RGB or RGBA. Used for images pulled out of PDFs
 * (raw Flate-compressed pixel buffers) and by the fixture generator.
 */

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

export type PngColor = "grey" | "rgb" | "rgba";

/**
 * Encode raw samples. `data` is `width*height*channels` bytes, top row first,
 * channels from `color` (1, 3 or 4). `invert` flips greyscale samples (PDF Decode arrays).
 */
export function encodePng(width: number, height: number, color: PngColor, data: Uint8Array, opts: { invert?: boolean } = {}): Buffer {
	const channels = color === "grey" ? 1 : color === "rgb" ? 3 : 4;
	const stride = width * channels;
	if (data.length < stride * height) throw new Error(`PNG data too short: ${data.length} < ${stride * height}`);
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		const src = y * stride;
		const dst = y * (stride + 1);
		raw[dst] = 0; // filter: none
		if (opts.invert && channels === 1) for (let x = 0; x < stride; x++) raw[dst + 1 + x] = data[src + x] ^ 0xff;
		else raw.set(data.subarray(src, src + stride), dst + 1);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = color === "grey" ? 0 : color === "rgb" ? 2 : 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 6 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
