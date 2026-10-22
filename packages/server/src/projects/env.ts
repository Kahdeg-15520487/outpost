import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { err, FileError, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/**
 * The execution environment of a project agent: pi-durable's Node environment with two fixes.
 *
 * 1. Git Bash paths. On Windows the agents' shell is Git Bash, so they see and reuse paths like
 *    `/c/Users/...` and `/tmp/...`. Node would resolve those against the current drive
 *    (`C:\c\Users\...`), so the file tools would quietly write outside the project. They are
 *    translated to Windows paths first.
 * 2. Writes stay inside the agent's working directory (its worktree). The file tools refuse to
 *    create, change or delete anything outside it; reads are unrestricted (attachments, docs).
 *    The shell is not confined; the role prompt covers it.
 */

/** Methods whose first argument is a path. */
const PATH_FIRST = new Set(["openTextLineReader", "readTextFile", "readTextLines", "readBinaryFile", "openBinaryReader", "writeFile", "appendFile", "truncateFile", "flushFile", "fileInfo", "listDir", "openDirReader", "canonicalPath", "exists", "createDir", "remove", "absolutePath", "listFiles"]);
/** Methods that change the file system at their path argument(s). */
const MUTATING = new Set(["writeFile", "appendFile", "truncateFile", "createDir", "remove"]);

export function fromGitBashPath(p: string): string {
	if (process.platform !== "win32" || typeof p !== "string") return p;
	const drive = /^\/([a-zA-Z])(?=\/|$)(.*)$/.exec(p);
	if (drive) return win32.normalize(`${drive[1]!.toUpperCase()}:${drive[2] || "\\"}`);
	if (p === "/tmp" || p.startsWith("/tmp/")) return win32.join(tmpdir(), p.slice(4));
	return p;
}

function inside(root: string, cwd: string, p: string) {
	const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
	const rel = relative(resolve(root), abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function agentEnv(cwd: string): ExecutionEnv {
	const inner = new NodeExecutionEnv({ cwd });
	const denied = (p: string) => err(new FileError("permission_denied", `Refusing to write outside your worktree (${cwd}): ${p}. Work only inside your worktree.`, p));
	return new Proxy(inner, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function" || typeof prop !== "string") return value;
			if (prop === "renameFile")
				return (from: string, to: string, ...rest: unknown[]) => {
					const [a, b] = [fromGitBashPath(from), fromGitBashPath(to)];
					if (!inside(cwd, cwd, a)) return Promise.resolve(denied(a));
					if (!inside(cwd, cwd, b)) return Promise.resolve(denied(b));
					return value.call(target, a, b, ...rest);
				};
			if (PATH_FIRST.has(prop))
				return (path: string, ...rest: unknown[]) => {
					const p = fromGitBashPath(path);
					if (MUTATING.has(prop) && !inside(cwd, cwd, p)) return Promise.resolve(denied(p));
					return value.call(target, p, ...rest);
				};
			if (prop === "exec")
				return (command: unknown, options: { cwd?: string } | undefined, ...rest: unknown[]) =>
					value.call(target, command, options?.cwd ? { ...options, cwd: fromGitBashPath(options.cwd) } : options, ...rest);
			return value.bind(target);
		},
	}) as ExecutionEnv;
}
