/**
 * OOXML packages (docx, xlsx, pptx) are zips of XML parts joined by relationships.
 * This wrapper gives a parser the three things it always needs: part lookup, part text,
 * and the rId → target map that turns `<a:blip r:embed="rId3"/>` into `word/media/image1.png`.
 */

import { posix } from "node:path";
import { documentElement, parseXml, type XmlNode } from "./xml.ts";
import { zipEntries, zipRead, type ZipEntry } from "../store.ts";

export interface Relationship {
	id: string;
	type: string;
	target: string;
	/** Part name inside the package, when the relationship is internal. */
	part?: string;
	external?: boolean;
}

export class Package {
	readonly #entries = new Map<string, ZipEntry>();
	readonly #cache = new Map<string, string>();

	constructor(
		readonly data: Buffer,
		readonly entries: ZipEntry[],
	) {
		for (const e of entries) this.#entries.set(e.name.replace(/^\/+/, ""), e);
	}

	names(): string[] {
		return [...this.#entries.keys()];
	}

	has(name: string): boolean {
		return this.#entries.has(name.replace(/^\/+/, ""));
	}

	bytes(name: string): Buffer {
		const key = name.replace(/^\/+/, "");
		const e = this.#entries.get(key);
		if (!e) throw new Error(`Package has no part ${name}`);
		return zipRead(this.data, e);
	}

	text(name: string): string {
		const key = name.replace(/^\/+/, "");
		const hit = this.#cache.get(key);
		if (hit !== undefined) return hit;
		const value = this.bytes(key).toString("utf8");
		if (value.length < 8 << 20) this.#cache.set(key, value);
		return value;
	}

	xml(name: string): XmlNode {
		return parseXml(this.text(name));
	}

	/** Relationships for a part ("word/document.xml" → word/_rels/document.xml.rels). */
	rels(partName: string): Map<string, Relationship> {
		const part = partName.replace(/^\/+/, "");
		const relPath = posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
		const map = new Map<string, Relationship>();
		if (!this.has(relPath)) return map;
		const root = documentElement(this.xml(relPath));
		for (const rel of root.children) {
			if (typeof rel === "string" || !rel.name.endsWith("Relationship")) continue;
			const id = rel.attrs.Id;
			const target = rel.attrs.Target ?? "";
			const external = rel.attrs.TargetMode === "External";
			const resolved = target.startsWith("/")
				? target.replace(/^\/+/, "")
				: posix.normalize(posix.join(posix.dirname(part), target));
			map.set(id, { id, type: rel.attrs.Type ?? "", target, external, ...(external ? {} : { part: resolved }) });
		}
		return map;
	}

	/** Root-level relationships (e.g. the officeDocument link in pptx/docx/xlsx). */
	rootRels(): Map<string, Relationship> {
		const map = new Map<string, Relationship>();
		if (!this.has("_rels/.rels")) return map;
		for (const rel of documentElement(this.xml("_rels/.rels")).children) {
			if (typeof rel === "string" || !rel.name.endsWith("Relationship")) continue;
			const target = (rel.attrs.Target ?? "").replace(/^\/+/, "");
			map.set(rel.attrs.Id, { id: rel.attrs.Id, type: rel.attrs.Type ?? "", target, part: target, external: rel.attrs.TargetMode === "External" });
		}
		return map;
	}
}

export function openPackage(data: Buffer): Package {
	return new Package(data, zipEntries(data));
}
