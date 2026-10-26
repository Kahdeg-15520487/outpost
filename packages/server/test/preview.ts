/**
 * Live previews behind a published port range — the container case. With `preview.ports` set, pi-os
 * doesn't hand the browser the dev server's own loopback port (unreachable from outside a container):
 * it takes a port from the range, listens on `preview.bind` and pipes to the app. The app keeps
 * listening on 127.0.0.1, exactly as before, so nothing about the projects changes.
 * Run: pnpm --filter @pi-os/server test:preview
 */
import { check, finish, freePort, testDir } from "./lib/harness.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A free port right now starts the range. Chosen before src/config.ts is imported (it reads the env),
// hence the dynamic imports below.
const start = await freePort();
process.env.PI_OS_PREVIEW_PORTS = `${start}-${start + 9}`;
process.env.PI_OS_PREVIEW_BIND = "127.0.0.1";

const { config } = await import("../src/config.ts");
const { PreviewManager } = await import("../src/projects/preview.ts");
import type { ProjectManager } from "../src/projects/manager.ts";

const APP = `
const http = require("http");
http.createServer((req, res) => res.end("hello from " + require("fs").readFileSync(__dirname + "/name.txt", "utf8").trim() + "\\n"))
  .listen(Number(process.env.PORT), process.env.HOST);
`;

/** A stand-in for a project checkout: preview.ts only needs these three things from the manager. */
function fakeProject(name: string, body: string): { root: string; previewDir: string; updatePreview(): Promise<string> } {
	const root = join(testDir, "projects", name);
	const previewDir = join(root, "preview");
	mkdirSync(join(previewDir, "app"), { recursive: true });
	mkdirSync(join(previewDir, ".pios"), { recursive: true });
	writeFileSync(join(previewDir, ".pios", "project.json"), JSON.stringify({ dev: { command: "node server.js", readyPath: "/" } }));
	writeFileSync(join(previewDir, "app", "server.js"), APP);
	writeFileSync(join(previewDir, "app", "name.txt"), body);
	return { root, previewDir, updatePreview: async () => "c0ffee" + name };
}

const repos = new Map<string, ReturnType<typeof fakeProject>>();
const manager = {
	ws: { id: "ws-preview" },
	channel: () => "preview-test",
	repo: (id: string) => repos.get(id)!,
} as unknown as ProjectManager;
const previews = new PreviewManager(manager);

const start1 = Date.now();
repos.set("p1", fakeProject("p1", "one"));
const one = await previews.start("p1", "test");
check("preview.ports: the browser port comes from the range", one.status === "running" && one.port === start, one);
check("preview.ports: the dev server itself stays on loopback", !!one.appPort && one.appPort !== one.port, one);
const body1 = await fetch(`http://127.0.0.1:${one.port}/`).then((r) => r.text(), (e) => String(e));
check("preview.ports: the range port serves the app", body1 === "hello from one\n", body1);
check("preview.ports: ready without waiting for the timeout", Date.now() - start1 < 30000, Date.now() - start1);
check("preview.ports: the log says where it is", /public preview on http:\/\/127\.0\.0\.1:\d+ → 127\.0\.0\.1:\d+/.test(previews.tail("p1")), previews.tail("p1"));

repos.set("p2", fakeProject("p2", "two"));
const two = await previews.start("p2", "test");
// Not necessarily start + 1: on Windows the OS hands out loopback ports sequentially, so the first
// dev server's own port can land inside this test range. What matters: another port, from the range.
check("preview.ports: a second project takes another port from the range", !!two.port && two.port !== one.port && two.port > start && two.port <= start + 9, [one.port, two.port]);
check("preview.ports: both run at once", (await fetch(`http://127.0.0.1:${two.port}/`).then((r) => r.text())) === "hello from two\n");

await previews.stop("p1", true);
const gone = await fetch(`http://127.0.0.1:${one.port}/`).then(
	(r) => r.text(),
	() => "refused",
);
check("preview.ports: stopping closes the public port", gone === "refused", gone);
check("preview.ports: the other preview is untouched", (await fetch(`http://127.0.0.1:${two.port}/`).then((r) => r.text())) === "hello from two\n");

check("preview.ports: parsed from the env", config.preview.ports?.[0] === start && config.preview.ports?.[1] === start + 9, config.preview.ports);

previews.stopAll();
await finish();
