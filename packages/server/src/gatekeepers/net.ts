import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Outbound HTTP for connectors whose address a user typed in. A workspace owner adding an MCP server
 * or an API must not be able to point pi-os at the machine it runs on, the local network, or a cloud
 * metadata endpoint. Connections an admin declares in pi-os.config.json skip the check, and
 * PI_OS_ALLOW_PRIVATE_HOSTS=1 turns it off (local development, tests).
 */
const blocked = new BlockList();
for (const [net, bits] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
	// (IPv4-mapped ::ffff:a.b.c.d is unwrapped and checked as IPv4 below: a ::ffff:0:0/96 rule here
	// would match every IPv4 address, since BlockList maps IPv4 into that range.)
	["64:ff9b::", 96],
] as const)
	blocked.addSubnet(net, bits, "ipv6");

export const privateHostsAllowed = () => process.env.PI_OS_ALLOW_PRIVATE_HOSTS === "1" || process.env.PI_OS_ALLOW_PRIVATE_HOSTS === "true";

export function isPrivateAddress(ip: string): boolean {
	const family = isIP(ip);
	if (!family) return true;
	if (family === 6) {
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
		if (mapped) return blocked.check(mapped[1]!, "ipv4");
	}
	return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Throws unless `url` is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string | URL, opts: { allowPrivate?: boolean } = {}): Promise<URL> {
	const url = new URL(raw);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Only http(s) URLs: ${url.protocol}`);
	if (opts.allowPrivate || privateHostsAllowed()) return url;
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
	if (!addresses.length) throw new Error(`${host} doesn't resolve`);
	const bad = addresses.find(isPrivateAddress);
	if (bad) throw new Error(`${host} resolves to a private or local address (${bad}); only public hosts are allowed for connections added in the UI. An admin can declare it in pi-os.config.json instead.`);
	return url;
}

export type GuardedResponse = { status: number; contentType: string | null; headers: Headers; text: string; truncated: boolean };

/**
 * fetch with the address check on every hop, redirects only within the same origin (at most 3), a
 * timeout, and a cap on the body read.
 */
export async function guardedFetch(raw: string | URL, init: RequestInit & { allowPrivate?: boolean; timeoutMs?: number; maxBytes?: number } = {}): Promise<GuardedResponse> {
	const { allowPrivate, timeoutMs = 30_000, maxBytes = 2 << 20, ...rest } = init;
	let url = await assertPublicUrl(raw, { allowPrivate });
	const origin = url.origin;
	for (let hop = 0; ; hop++) {
		const res = await fetch(url, { ...rest, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
		const location = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && location) {
			const next = new URL(location, url);
			if (next.origin !== origin) throw new Error(`Refusing a redirect to another host: ${next.origin}`);
			if (hop >= 3) throw new Error("Too many redirects");
			url = await assertPublicUrl(next, { allowPrivate });
			continue;
		}
		const { text, truncated } = await readCapped(res, maxBytes);
		return { status: res.status, contentType: res.headers.get("content-type"), headers: res.headers, text, truncated };
	}
}

/**
 * A fetch for clients that stream (the MCP SDK's transports): the same address check and same-origin
 * redirect rule as guardedFetch, but the response is returned unread.
 */
export function checkedFetch(opts: { allowPrivate?: boolean } = {}) {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		let url = await assertPublicUrl(input instanceof Request ? input.url : input, opts);
		const origin = url.origin;
		for (let hop = 0; ; hop++) {
			const res = await fetch(input instanceof Request && hop === 0 ? input : url, { ...init, redirect: "manual" });
			const location = res.headers.get("location");
			if (!(res.status >= 300 && res.status < 400 && location)) return res;
			const next = new URL(location, url);
			if (next.origin !== origin) throw new Error(`Refusing a redirect to another host: ${next.origin}`);
			if (hop >= 3) throw new Error("Too many redirects");
			url = await assertPublicUrl(next, opts);
		}
	};
}

async function readCapped(res: Response, maxBytes: number) {
	if (!res.body) return { text: "", truncated: false };
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (size + value.byteLength > maxBytes) {
			chunks.push(value.subarray(0, maxBytes - size));
			truncated = true;
			await reader.cancel().catch(() => {});
			break;
		}
		chunks.push(value);
		size += value.byteLength;
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}
