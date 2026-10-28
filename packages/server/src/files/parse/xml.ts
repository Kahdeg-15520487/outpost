/**
 * A small, strict-enough XML reader for OOXML parts. It keeps namespace prefixes as written
 * (`w:p`, `a:tbl`) and gives prefix-insensitive lookups, because every OOXML consumer wants
 * "the local name" and almost never the namespace URI.
 */

export interface XmlNode {
	name: string;
	attrs: Record<string, string>;
	children: XmlEl[];
}
export type XmlEl = string | XmlNode;

const NAMED: Record<string, string> = {
	lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: "\u00a0",
	mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018",
	rdquo: "\u201d", ldquo: "\u201c", bull: "\u2022", middot: "\u00b7", copy: "\u00a9",
	trade: "\u2122", reg: "\u00ae", deg: "\u00b0", euro: "\u20ac", pound: "\u00a3", yen: "\u00a5",
};

export function decodeEntities(s: string): string {
	if (!s.includes("&")) return s;
	return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return NAMED[body] ?? whole;
	});
}

export const localName = (name: string) => {
	const i = name.indexOf(":");
	return i < 0 ? name : name.slice(i + 1);
};

/** Parse an XML document (declaration, doctype, comments, CDATA, entities). Tolerant of stray text. */
export function parseXml(src: string): XmlNode {
	const root: XmlNode = { name: "#root", attrs: {}, children: [] };
	const stack: XmlNode[] = [root];
	let i = 0;
	const n = src.length;

	const pushText = (text: string) => {
		if (text) stack[stack.length - 1].children.push(decodeEntities(text));
	};

	while (i < n) {
		const lt = src.indexOf("<", i);
		if (lt < 0) {
			pushText(src.slice(i));
			break;
		}
		if (lt > i) pushText(src.slice(i, lt));

		// comments, doctype, CDATA, processing instructions
		if (src.startsWith("<!--", lt)) {
			const end = src.indexOf("-->", lt + 4);
			i = end < 0 ? n : end + 3;
			continue;
		}
		if (src.startsWith("<![CDATA[", lt)) {
			const end = src.indexOf("]]>", lt + 9);
			stack[stack.length - 1].children.push(src.slice(lt + 9, end < 0 ? n : end));
			i = end < 0 ? n : end + 3;
			continue;
		}
		if (src[lt + 1] === "?" || src[lt + 1] === "!") {
			// doctype may carry an internal subset with a stray '>'
			if (/^<!DOCTYPE/i.test(src.slice(lt, lt + 9))) {
				let depth = 0;
				let j = lt;
				for (; j < n; j++) {
					const c = src[j];
					if (c === "[") depth++;
					else if (c === "]") depth--;
					else if (c === ">" && depth <= 0) break;
				}
				i = j + 1;
			} else {
				const end = src.indexOf(">", lt);
				i = end < 0 ? n : end + 1;
			}
			continue;
		}

		const close = src[lt + 1] === "/";
		let j = lt + (close ? 2 : 1);
		let name = "";
		while (j < n && !/[\s/>]/.test(src[j])) name += src[j++];

		if (close) {
			const end = src.indexOf(">", j);
			i = end < 0 ? n : end + 1;
			// pop to the matching element; ignore unmatched closers
			for (let k = stack.length - 1; k > 0; k--) {
				if (stack[k].name === name) {
					stack.length = k;
					break;
				}
			}
			continue;
		}

		const node: XmlNode = { name, attrs: {}, children: [] };
		let selfClose = false;
		while (j < n) {
			while (j < n && /\s/.test(src[j])) j++;
			if (src[j] === ">") {
				j++;
				break;
			}
			if (src[j] === "/" && src[j + 1] === ">") {
				selfClose = true;
				j += 2;
				break;
			}
			let key = "";
			while (j < n && !/[\s=/>]/.test(src[j])) key += src[j++];
			while (j < n && /\s/.test(src[j])) j++;
			let value = "";
			if (src[j] === "=") {
				j++;
				while (j < n && /\s/.test(src[j])) j++;
				const quote = src[j];
				if (quote === '"' || quote === "'") {
					const end = src.indexOf(quote, j + 1);
					value = src.slice(j + 1, end < 0 ? n : end);
					j = end < 0 ? n : end + 1;
				} else {
					while (j < n && !/[\s>]/.test(src[j])) value += src[j++];
				}
			}
			if (key) node.attrs[key] = decodeEntities(value);
		}
		stack[stack.length - 1].children.push(node);
		if (!selfClose) stack.push(node);
		i = j;
	}

	return root;
}

export const isNode = (el: XmlEl | undefined): el is XmlNode => typeof el === "object" && el !== null;

/** Attribute by exact name or local name (`r:embed` matches `embed`). */
export function attr(node: XmlNode | undefined, ...names: string[]): string | undefined {
	if (!node) return undefined;
	for (const want of names) {
		const direct = node.attrs[want];
		if (direct !== undefined) return direct;
		const wantLocal = localName(want);
		for (const [k, v] of Object.entries(node.attrs)) if (localName(k) === wantLocal) return v;
	}
	return undefined;
}

export const childrenNamed = (node: XmlNode | undefined, name: string): XmlNode[] =>
	(node?.children ?? []).filter((c): c is XmlNode => isNode(c) && localName(c.name) === localName(name));

export const firstChild = (node: XmlNode | undefined, name: string): XmlNode | undefined => childrenNamed(node, name)[0];

/** The document element: `parseXml` wraps everything in a synthetic `#root`. */
export const documentElement = (root: XmlNode): XmlNode => root.children.find(isNode) ?? root;

/** Depth-first search over one node's subtree (not including it). */
export function* descend(node: XmlNode): Generator<XmlNode> {
	for (const c of node.children) {
		if (isNode(c)) {
			yield c;
			yield* descend(c);
		}
	}
}

export const findAll = (node: XmlNode, name: string): XmlNode[] => [...descend(node)].filter((c) => localName(c.name) === localName(name));

export function textContent(el: XmlEl | XmlEl[] | undefined): string {
	if (el === undefined) return "";
	if (typeof el === "string") return el;
	if (Array.isArray(el)) return el.map(textContent).join("");
	return el.children.map(textContent).join("");
}
