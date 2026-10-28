/**
 * Parsed-file results are fetched only when a tab needs them, then cached in the browser:
 * memory first, then the Cache API, so reopening a file (or a second tab) does not re-download
 * a possibly large rendering. The server keeps the authoritative parse.
 */

const TTL = 10 * 60 * 1000;
const CACHE = "outpost-parsed";
const memory = new Map<string, { at: number; body: string }>();

export async function cachedJson(url: string, opts: { refresh?: boolean } = {}): Promise<any> {
	if (!opts.refresh) {
		const hit = memory.get(url);
		if (hit && Date.now() - hit.at < TTL) return JSON.parse(hit.body);
	}
	if (typeof caches !== "undefined") {
		try {
			const cache = await caches.open(CACHE);
			if (!opts.refresh) {
				const cached = await cache.match(url);
				if (cached) {
					const body = await cached.text();
					memory.set(url, { at: Date.now(), body });
					return JSON.parse(body);
				}
			}
			const res = await fetch(url, { credentials: "same-origin" });
			if (res.ok) {
				const body = await res.text();
				await cache.put(url, new Response(body, { headers: { "content-type": "application/json" } }));
				memory.set(url, { at: Date.now(), body });
				return JSON.parse(body);
			}
			return await res.json().catch(() => ({}));
		} catch {
			/* cache unavailable (private mode, quota): fall through to a plain fetch */
		}
	}
	const res = await fetch(url, { credentials: "same-origin" });
	const body = await res.text();
	memory.set(url, { at: Date.now(), body });
	return JSON.parse(body);
}

/** Drop everything cached for one file (after a re-parse or a conversion). */
export async function forgetParsed(fileId: string): Promise<void> {
	for (const key of [...memory.keys()]) if (key.includes(`/files/${fileId}/`)) memory.delete(key);
	if (typeof caches === "undefined") return;
	try {
		const cache = await caches.open(CACHE);
		for (const request of await cache.keys()) if (request.url.includes(`/files/${fileId}/`)) await cache.delete(request);
	} catch {
		/* nothing to drop */
	}
}
