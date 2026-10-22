/**
 * Builds the HTML of a gadget's client. It runs in `<iframe sandbox="allow-scripts">` (an opaque
 * origin: no cookies, no storage, no access to the OS page) under a CSP that forbids every network
 * request. Its only channel is postMessage to the parent, which relays RPC to the gadget server.
 */
export const FRAME_CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline' 'unsafe-eval'",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"media-src data: blob:",
	"font-src data:",
	"connect-src 'none'",
	"frame-src 'none'",
	"worker-src blob:",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

const BOOTSTRAP = (boot: object) => `<script>(() => {
  const boot = ${JSON.stringify(boot).replace(/</g, "\\u003c")};
  const pending = new Map(), handlers = new Map(), presenceFns = new Set();
  let seq = 0;
  const post = (m) => parent.postMessage(Object.assign({ __pios: 1 }, m), "*");
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.__pios !== 1) return;
    if (m.t === "result") {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
    } else if (m.t === "event") {
      for (const fn of [...(handlers.get(m.event) || []), ...(handlers.get("*") || [])]) {
        try { fn(m.data, m.event); } catch (err) { console.error(err); }
      }
    } else if (m.t === "presence") {
      gadget.presence = m.users;
      for (const fn of presenceFns) { try { fn(m.users); } catch (err) { console.error(err); } }
    }
  });
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    post({ t: "call", id, method, args });
  });
  window.gadget = {
    id: boot.gadgetId, user: boot.user, presence: [], call,
    api: new Proxy({}, { get: (_, m) => m === "then" ? undefined : (...a) => call(String(m), ...a) }),
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return () => handlers.get(event).delete(fn); },
    onPresence(fn) { presenceFns.add(fn); fn(gadget.presence); return () => presenceFns.delete(fn); },
  };
  addEventListener("error", (e) => post({ t: "error", message: String(e.message || e.error) }));
  addEventListener("unhandledrejection", (e) => post({ t: "error", message: String(e.reason && e.reason.message || e.reason) }));
  try { Object.defineProperty(window, "localStorage", { get() { throw new Error("localStorage is unavailable in gadgets; persist through the server (ctx.storage)."); } }); } catch {}
  post({ t: "ready" });
})();</script>`;

const escapeScript = (s: string) => s.replace(/<\/script/gi, "<\\/script");
const isLocal = (ref: string) => !/^([a-z]+:)?\/\//i.test(ref) && !ref.startsWith("data:");

export function buildFrame(files: Readonly<Record<string, string>>, boot: { gadgetId: string; user: object }): string {
	let html = files["index.html"] ?? "<!doctype html><p>This gadget has no index.html yet.</p>";
	html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (whole, pre, src, post) => {
		if (!isLocal(src)) return `<!-- blocked external script ${src} -->`;
		const body = files[src.replace(/^\.?\//, "")];
		if (body === undefined) return `<!-- missing ${src} -->`;
		return `<script${pre}${post}>${escapeScript(body)}</script>`;
	});
	html = html.replace(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi, (whole, href) => {
		if (!/rel=["']?stylesheet/i.test(whole)) return whole;
		if (!isLocal(href)) return `<!-- blocked external stylesheet ${href} -->`;
		const body = files[href.replace(/^\.?\//, "")];
		return body === undefined ? `<!-- missing ${href} -->` : `<style>${body}</style>`;
	});
	const inject = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${BOOTSTRAP(boot)}`;
	if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (h) => `${h}${inject}`);
	if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (h) => `${h}<head>${inject}</head>`);
	return `<!doctype html><head>${inject}</head>${html}`;
}
