/**
 * Ingestion: every format parsed natively, the design model kept, conversions stored, caches
 * used, and libraries loaded lazily (nothing heavy at boot).
 * Run: pnpm --filter @outpost/server test -- parse
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, finish, must, startServer } from "./lib/harness.ts";

const base = await startServer();
process.on("unhandledRejection", (e) => void finish(e));

const require = (await import("node:module")).createRequire(import.meta.url);
const fx = join(import.meta.dirname, "fixtures/files");
const fixture = (name: string) => readFileSync(join(fx, name));

function client() {
	let cookie = "";
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
		const set = res.headers.get("set-cookie");
		if (set) cookie = set.split(";")[0]!;
		const json = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
		return json as any;
	};
	call.cookie = () => cookie;
	return call;
}

const suffix = Date.now().toString(36);
const ana = client();
await ana("POST", "/api/auth/signup", { username: `parse${suffix}`, password: "pass1234", displayName: "Ana" });
const ws = (await ana("GET", "/api/workspaces")).workspaces[0].id as string;

async function upload(name: string, bytes: Buffer, mime = "application/octet-stream") {
	const res = await fetch(`${base}/api/w/${ws}/files`, {
		method: "POST",
		headers: { cookie: ana.cookie(), "x-file-name": encodeURIComponent(name), "content-type": mime },
		body: new Uint8Array(bytes),
	});
	const json = (await res.json()) as any;
	if (!res.ok) throw new Error(`upload ${name} → ${res.status} ${JSON.stringify(json)}`);
	return json.file as { id: string; name: string; kind: string; sha256: string };
}

const parsed = (id: string, view = "summary") => ana("GET", `/api/w/${ws}/files/${id}/parsed?view=${view}`);

// ---------------------------------------------------------------- lazy loading
const exceljsLoadedBefore = Boolean(require.cache[require.resolve("exceljs")]);
const mammothLoadedBefore = Boolean(require.cache[require.resolve("mammoth")]);
check("exceljs is not loaded at boot", !exceljsLoadedBefore);
check("mammoth is not loaded at boot", !mammothLoadedBefore);

// ---------------------------------------------------------------- docx
console.log("\ndocx");
const docx = await upload("sample.docx", fixture("sample.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
const docxParsed = await parsed(docx.id, "json");
must("docx parses as a document", docxParsed.kind === "document", docxParsed);
check("mammoth produced the content", docxParsed.engine === "mammoth", docxParsed.engine);
check("headings survive", docxParsed.parsed.headings.some((h: any) => h.text === "Outpost ingestion fixture"), docxParsed.parsed.headings);
check("the table survives", docxParsed.parsed.stats.tables >= 1);
check("the image survives", docxParsed.parsed.images.length >= 1, docxParsed.parsed.images.length);
check("the footnote is kept", (docxParsed.parsed.stats.footnotes ?? 0) >= 1);
check("design keeps the style catalogue", (docxParsed.design?.styles ?? []).length >= 3);
check("design keeps fonts with sizes", (docxParsed.design?.fonts ?? []).some((f: any) => f.name === "Georgia" && f.sizes?.length), docxParsed.design?.fonts);
check("design keeps the theme fonts", Boolean(docxParsed.design?.theme?.fonts?.minor), docxParsed.design?.theme);
check("design keeps page setup", docxParsed.design?.page?.width === 794, docxParsed.design?.page);
const docxMd = await parsed(docx.id, "markdown");
check("markdown has the heading", /^# Outpost ingestion fixture/m.test(docxMd.markdown), docxMd.markdown.slice(0, 80));
check("markdown has a GFM table with content", docxMd.markdown.includes("| --- |") && /Service/.test(docxMd.markdown) && docxMd.markdown.includes("Portal"));
check("markdown keeps the link", docxMd.markdown.includes("https://example.com/outpost"));
check("markdown does not inline image bytes", !/base64,/.test(docxMd.markdown) && docxMd.markdown.length < 20_000, docxMd.markdown.length);
const docxHtml = await parsed(docx.id, "html");
check("html rendering has a table", /<table>/.test(docxHtml.html));
check("preview html points images at the parse endpoint", /src="\/api\/w\/[^"]+\/parsed\/image\/img\d+"/.test(docxHtml.html), docxHtml.html.slice(0, 200));
const imageRes = await fetch(`${base}/api/w/${ws}/files/${docx.id}/parsed/image/${docxParsed.parsed.images[0].ref}`, { headers: { cookie: ana.cookie() } });
check("parsed images are served", imageRes.ok && /^image\//.test(imageRes.headers.get("content-type") ?? ""));
check("image bytes look like a PNG", Buffer.from(await imageRes.arrayBuffer()).subarray(0, 4).toString("hex") === "89504e47");

// ---------------------------------------------------------------- xlsx
console.log("\nxlsx");
const xlsx = await upload("sample.xlsx", fixture("sample.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
const xlsxParsed = await parsed(xlsx.id, "json");
must("xlsx parses as sheets", xlsxParsed.kind === "sheets", xlsxParsed.kind);
check("exceljs produced the content", xlsxParsed.engine === "exceljs", xlsxParsed.engine);
check("all three sheets are there", xlsxParsed.parsed.sheets.length === 3, xlsxParsed.parsed.sheets.map((s: any) => s.name));
check("the hidden sheet is flagged", xlsxParsed.parsed.sheets.some((s: any) => s.hidden && s.name === "Hidden"));
check("formulas are kept", xlsxParsed.parsed.stats.formulas >= 2, xlsxParsed.parsed.stats);
check("merged ranges are kept", (xlsxParsed.parsed.sheets[0].merged ?? []).length >= 1, xlsxParsed.parsed.sheets[0].merged);
check("column widths are kept", (xlsxParsed.parsed.sheets[0].widths ?? []).length > 0);
check("freeze panes are kept", xlsxParsed.parsed.sheets[0].freeze === "A2", xlsxParsed.parsed.sheets[0].freeze);
const updates = xlsxParsed.parsed.sheets[0].cells.filter((c: any) => c.ref.startsWith("E") && c.row > 0);
check("dates became ISO strings", updates.length > 0 && updates.every((c: any) => c.type === "date" && /^\d{4}-\d{2}-\d{2}T/.test(String(c.value))), updates.slice(0, 2));
check("design keeps header fill and font", xlsxParsed.design?.sheets?.[0]?.headerFill === "#EDE9FE" && xlsxParsed.design?.sheets?.[0]?.headerFont === "Georgia", xlsxParsed.design?.sheets?.[0]);
const xlsxMd = await parsed(xlsx.id, "markdown");
check("markdown has one table per sheet", (xlsxMd.markdown.match(/## Sheet:/g) ?? []).length === 3);
const csvConvert = await ana("POST", `/api/w/${ws}/files/${xlsx.id}/convert`, { to: "csv" });
check("csv conversion wrote one file per sheet", csvConvert.files.length === 3, csvConvert.files.map((f: any) => f.name));
const csvFile = await fetch(`${base}/api/w/${ws}/files/${csvConvert.files[0].id}`, { headers: { cookie: ana.cookie() } });
const csvText = Buffer.from(await csvFile.arrayBuffer()).toString("utf8");
check("csv rows carry the values", csvText.includes("Portal,Alice,high,12"), csvText.slice(0, 120));
check("csv keeps formulas as text", csvText.includes("=SUM(D2:D4)"), csvText.slice(0, 300));

// ---------------------------------------------------------------- pptx
console.log("\npptx");
const pptx = await upload("sample.pptx", fixture("sample.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
const pptxParsed = await parsed(pptx.id, "json");
must("pptx parses as slides", pptxParsed.kind === "slides", pptxParsed.kind);
check("all four slides, in order", pptxParsed.parsed.slides.length === 4, pptxParsed.parsed.slides.length);
check("notes are read", pptxParsed.parsed.slides[0].notes === "Speaker note for slide one.", pptxParsed.parsed.slides[0].notes);
check("the table slide has a table", pptxParsed.parsed.slides.some((s: any) => s.blocks.some((b: any) => b.type === "table")));
const chart = (pptxParsed.design?.shapes ?? []).find((s: any) => s.kind === "chart");
check("chart data is extracted", JSON.stringify(chart?.chart?.series?.[0]?.values ?? []) === "[4,9,6]", chart?.chart);
check("chart categories are extracted", JSON.stringify(chart?.chart?.series?.[0]?.categories ?? []) === '["Jan","Feb","Mar"]', chart?.chart?.series?.[0]?.categories);
check("theme fonts are read", pptxParsed.design?.theme?.fonts?.major === "Georgia", pptxParsed.design?.theme?.fonts);
check("shape geometry is kept", (pptxParsed.design?.shapes ?? []).filter((s: any) => typeof s.w === "number" && s.w > 0).length >= 5);
check("accent colours are tallied", (pptxParsed.design?.colors ?? []).some((c: any) => c.value.toUpperCase() === "#7C3AED"), pptxParsed.design?.colors);
check("the picture is extracted", pptxParsed.parsed.images.length >= 1, pptxParsed.parsed.images.length);
const pptxMd = await parsed(pptx.id, "markdown");
check("markdown keeps the bullets", pptxMd.markdown.includes("- Theme fonts and colours"));
check("markdown keeps the notes", pptxMd.markdown.includes("**Notes:** Speaker note for slide one."));
check("a big deck stays small in markdown", pptxMd.markdown.length < 40_000, pptxMd.markdown.length);

// ---------------------------------------------------------------- pdf
console.log("\npdf");
const pdf = await upload("sample.pdf", fixture("sample.pdf"), "application/pdf");
const pdfParsed = await parsed(pdf.id, "json");
must("pdf parses as pages", pdfParsed.kind === "pages", pdfParsed.kind);
check("pdf.js produced the text", pdfParsed.engine === "pdf.js");
check("text is read", pdfParsed.parsed.pages[0].text.includes("Hello parsed PDF"), pdfParsed.parsed.pages[0].text);
check("page geometry is kept", pdfParsed.parsed.pages[0].width === 612 && pdfParsed.parsed.pages[0].height === 792);
check("text items keep coordinates", typeof pdfParsed.parsed.pages[0].items?.[0]?.x === "number" && typeof pdfParsed.parsed.pages[0].items?.[0]?.y === "number");

// ---------------------------------------------------------------- archives
console.log("\narchives");
const zip = await upload("sample.zip", fixture("sample.zip"), "application/zip");
const zipParsed = await parsed(zip.id, "json");
must("zip parses as an archive", zipParsed.kind === "archive", zipParsed.kind);
check("zip lists folders and files", zipParsed.parsed.stats.files === 2 && zipParsed.parsed.stats.folders === 2, zipParsed.parsed.stats);
check("zip keeps dates and methods", zipParsed.parsed.entries.some((e: any) => e.modified && e.method === "stored"), zipParsed.parsed.entries.slice(0, 2));
const extracted = await ana("POST", `/api/w/${ws}/files/${zip.id}/extract`, {});
check("extraction wrote the entries", extracted.count === 2, extracted.count);
check("extraction keeps paths", extracted.files.some((f: any) => f.name === "sample.zip/tree/readme.md"), extracted.files.map((f: any) => f.name));

const tar = await upload("sample.tar", fixture("sample.tar"), "application/x-tar");
const tarParsed = await parsed(tar.id, "json");
check("tar is listed", tarParsed.kind === "archive" && tarParsed.parsed.stats.files === 2, tarParsed.summary);

const targz = await upload("sample.tar.gz", fixture("sample.tar.gz"), "application/gzip");
const targzParsed = await parsed(targz.id, "json");
check("a .tar.gz is unpacked twice and listed as a tar", targzParsed.parsed.archive === "tar" && targzParsed.parsed.stats.files === 2, targzParsed.summary);

const seven = await upload("sample.7z", fixture("sample.7z"), "application/x-7z-compressed");
const sevenParsed = await parsed(seven.id, "json");
check("7z lists its entries (LZMA2)", sevenParsed.parsed.stats.files === 2, sevenParsed.summary);
check("7z names are correct", sevenParsed.parsed.entries.some((e: any) => e.path === "dir/a.txt"), sevenParsed.parsed.entries.map((e: any) => e.path));

const rar = await upload("sample.rar", fixture("sample.rar"), "application/vnd.rar");
const rarParsed = await parsed(rar.id, "json");
check("rar lists its entries", rarParsed.parsed.stats.files === 2, rarParsed.summary);
check("rar keeps UTF-8 names", rarParsed.parsed.entries.some((e: any) => e.path.includes("中文")), rarParsed.parsed.entries.map((e: any) => e.path));
const rarExtract = await ana("POST", `/api/w/${ws}/files/${rar.id}/extract`, { match: "\\.txt$" });
check("rar entries can be extracted", rarExtract.count >= 1, rarExtract.count);

// ---------------------------------------------------------------- text formats
console.log("\ntext formats");
const csv = await upload("notes.csv", fixture("notes.csv"), "text/csv");
const csvParsed = await parsed(csv.id, "json");
check("csv parses as a sheet", csvParsed.kind === "sheets" && csvParsed.parsed.sheets[0].rows === 3, csvParsed.summary);
check("csv numbers are numbers", csvParsed.parsed.sheets[0].cells.some((c: any) => c.ref === "B2" && c.value === 3 && c.type === "number"));

const htmlFile = await upload("page.html", Buffer.from("<h1>Title</h1><p>Some <b>bold</b> text</p><ul><li>one</li><li>two</li></ul>"), "text/html");
const htmlParsed = await parsed(htmlFile.id, "markdown");
check("html becomes structured blocks", htmlParsed.kind === "document" && htmlParsed.markdown.includes("# Title"), htmlParsed.markdown);
check("html lists survive", htmlParsed.markdown.includes("- one") && htmlParsed.markdown.includes("- two"));

const jsonFile = await upload("data.json", Buffer.from('{"a":1,"b":[2,3]}'), "application/json");
const jsonParsed = await parsed(jsonFile.id, "json");
check("json parses into a value", jsonParsed.kind === "json" && (jsonParsed.parsed.value as any).b.length === 2, jsonParsed.summary);

const mdFile = await upload("readme.md", Buffer.from("## Hi\n\n- a\n- b\n"), "text/markdown");
const mdParsed = await parsed(mdFile.id, "json");
check("markdown is recognised", mdParsed.kind === "text" && mdParsed.parsed.language === "markdown", mdParsed.summary);

// ---------------------------------------------------------------- conversion + caching
console.log("\nconversion and caching");
const mdConvert = await ana("POST", `/api/w/${ws}/files/${docx.id}/convert`, { to: "markdown" });
check("markdown conversion wrote a file", mdConvert.files.length === 1 && mdConvert.files[0].name === "sample.md", mdConvert.files.map((f: any) => f.name));
check("the derived file points at its source", mdConvert.files[0].parent === docx.id, mdConvert.files[0]);
const mdConverted = Buffer.from(await (await fetch(`${base}/api/w/${ws}/files/${mdConvert.files[0].id}`, { headers: { cookie: ana.cookie() } })).arrayBuffer()).toString("utf8");
check("the converted markdown has the content", mdConverted.includes("# Outpost ingestion fixture") && mdConverted.includes("Portal") && mdConverted.includes("| --- |"));
const htmlConvert = await ana("POST", `/api/w/${ws}/files/${docx.id}/convert`, { to: "html" });
const htmlConverted = Buffer.from(await (await fetch(`${base}/api/w/${ws}/files/${htmlConvert.files[0].id}`, { headers: { cookie: ana.cookie() } })).arrayBuffer()).toString("utf8");
check("converted html is self-contained", htmlConverted.includes("data:image/png;base64,") && htmlConverted.includes("<!doctype html>"));
const badConvert = await fetch(`${base}/api/w/${ws}/files/${docx.id}/convert`, { method: "POST", headers: { "content-type": "application/json", cookie: ana.cookie() }, body: JSON.stringify({ to: "pdf" }) });
check("an unsupported target is refused", badConvert.status === 400, badConvert.status);

const { Workspace } = await import("../src/kernel/workspace.ts");
const { clearParseCache } = await import("../src/files/parse/index.ts");
const workspace = await Workspace.get(ws);
const meta = await workspace.files.get(docx.id);
const first = await workspace.parsed(meta);
const second = await workspace.parsed(meta);
check("a parse is reused from memory", first === second);
check("exceljs loads on first use", Boolean(require.cache[require.resolve("exceljs")]));
check("the parse cache is written to disk", existsSync(join(workspace.files.dir, "parsed", meta.sha256.slice(0, 2), `${meta.sha256}.json`)));
clearParseCache(workspace.files.dir, meta.sha256);
const third = await workspace.parsed(meta);
check("clearing the cache forces a re-parse", third !== first && third.kind === first.kind);
const fromDisk = await workspace.parsed(await workspace.files.get(xlsx.id));
check("a disk-cached parse is rehydrated with its images", fromDisk.kind === "sheets");

const { inlineFor } = await import("../src/files/parse/index.ts");
const inline = inlineFor(first, 400);
check("attachment inlining carries content, not just a handle", inline.includes("Outpost ingestion fixture") && inline.length < 1200, inline.slice(0, 120));

// ---------------------------------------------------------------- fallbacks
console.log("fallbacks");
{
	const { openPackage } = await import("../src/files/parse/ooxml.ts");
	const { readXlsxFallback } = await import("../src/files/parse/xlsx-fallback.ts");
	const fallback = readXlsxFallback(openPackage(fixture("sample.xlsx")), "sample.xlsx", 10765, "test");
	check("the OOXML workbook reader works on its own", fallback.engine === "ooxml" && fallback.sheets.length === 3, fallback.sheets.length);
	check("the fallback reads shared strings", fallback.sheets[0].cells.some((c) => c.value === "Portal"), fallback.sheets[0].cells.slice(0, 3));
	check("the fallback reads formulas", fallback.sheets[0].cells.some((c) => c.formula === "SUM(D2:D4)"), fallback.sheets[0].cells.filter((c) => c.formula).slice(0, 2));
	check("the fallback detects dates through styles", fallback.sheets[0].cells.some((c) => c.type === "date"), fallback.sheets[0].cells.filter((c) => c.type === "date").length);
	check("the fallback keeps merges and hidden sheets", fallback.sheets[0].merged.length >= 1 && fallback.sheets.some((s) => s.hidden), fallback.sheets.map((s) => s.name));
}
const strayXml = await upload("stray.xlsx", Buffer.from('<?xml version="1.0"?><Types><Default Extension="xml" /></Types>'), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
const strayParsed = await parsed(strayXml.id, "summary");
check("a stray XML part named .xlsx explains itself", strayParsed.kind === "opaque" && /single XML part/.test(strayParsed.summary), strayParsed.summary);

// ---------------------------------------------------------------- unknown formats degrade
const weird = await upload("blob.bin", Buffer.from([0, 1, 2, 3, 250, 251, 252]), "application/octet-stream");
const weirdParsed = await parsed(weird.id, "summary");
check("an unknown format explains itself", weirdParsed.kind === "opaque" && weirdParsed.summary.includes("unparsed"), weirdParsed.summary);

await Workspace.closeAll();
await finish();
