import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";

/**
 * A project on disk (see docs/design/agent-teams.md, "Repository layout"):
 *   repo/                 git; `main` = the product as merged so far (the Lead works here)
 *     README.md             what the product is and how to run it
 *     .pios/project.json    install/test/dev commands pi-os runs (inside app/)
 *     app/                  everything the application needs to build and run, nothing else
 *     docs/                 requirements, design, backlog snapshot, decisions, wireframes, prototypes
 *   attachments/          the user's uploads; outside git, agents read them in place
 *   worktrees/<agent>/    one worktree per agent, on branch `agent/<agent>`
 * Agents never share a working tree, so parallel work can't trample files; their work reaches
 * `main` only through `publish()` (a merge). Reads for the UI come from `main`'s HEAD.
 */
export const projectsDir = join(config.dataDir, "projects");

const IDENTITY = ["-c", "user.name=pi-os agents", "-c", "user.email=agents@pi-os.local", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main"];

export class GitError extends Error {}

export function git(cwd: string, args: string[], opts: { input?: string; maxBuffer?: number } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile("git", [...IDENTITY, ...args], { cwd, maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err) reject(new GitError(`git ${args.join(" ")}: ${(stderr || err.message).trim()}`));
			else resolve(stdout);
		});
		if (opts.input !== undefined) child.stdin?.end(opts.input);
	});
}

/** Serialize operations that touch one project's `main` (merges), so two publishes never interleave. */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
	const run = (locks.get(key) ?? Promise.resolve()).then(work, work);
	locks.set(
		key,
		run.catch(() => {}),
	);
	return run;
}

export class ProjectRepo {
	readonly root: string;
	readonly main: string;
	constructor(readonly projectId: string) {
		this.root = join(projectsDir, projectId);
		this.main = join(this.root, "repo");
	}

	worktree(agentKey: string) {
		return join(this.root, "worktrees", agentKey);
	}

	/** The user's uploads: outside git, read in place by agents, never committed. */
	get attachmentsDir() {
		return join(this.root, "attachments");
	}

	branch(agentKey: string) {
		return `agent/${agentKey}`;
	}

	async init(goal: string, name: string) {
		mkdirSync(this.main, { recursive: true });
		mkdirSync(this.attachmentsDir, { recursive: true });
		if (existsSync(join(this.main, ".git"))) return;
		await git(this.main, ["init", "-q", "-b", "main"]);
		const files: Record<string, string> = {
			"README.md": `# ${name}\n\n${goal.trim()}\n\n## Layout\n\n- \`app/\` — the application: everything it needs to build and run.\n- \`docs/\` — requirements, design, backlog, decision records (\`docs/decisions/\`), wireframes and throwaway prototypes.\n- \`.pios/project.json\` — how pi-os installs, tests and runs the app.\n`,
			".gitignore": "node_modules/\ndist/\nbuild/\n.env\n.env.*\n*.log\n.DS_Store\n",
			"app/.gitkeep": "",
			"docs/decisions/.gitkeep": "",
			"docs/wireframes/.gitkeep": "",
			"docs/prototypes/.gitkeep": "",
		};
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(join(this.main, path, ".."), { recursive: true });
			writeFileSync(join(this.main, path), content);
		}
		await git(this.main, ["add", "-A"]);
		await git(this.main, ["commit", "-q", "-m", "Project created"]);
	}

	/** The agent's own worktree on its own branch, created from the current `main` on first use. */
	async ensureWorktree(agentKey: string): Promise<string> {
		const dir = this.worktree(agentKey);
		if (existsSync(join(dir, ".git"))) return dir;
		mkdirSync(join(this.root, "worktrees"), { recursive: true });
		const exists = (await git(this.main, ["branch", "--list", this.branch(agentKey)])).trim();
		await git(this.main, ["worktree", "add", "-q", ...(exists ? [dir, this.branch(agentKey)] : ["-b", this.branch(agentKey), dir, "main"])]);
		return dir;
	}

	/**
	 * Commit everything in the agent's worktree and merge its branch into `main`. Merges `main` into the
	 * branch first, so a conflict is reported to the agent (in its own tree) instead of breaking `main`.
	 */
	publish(agentKey: string, message: string): Promise<{ merged: boolean; commit?: string; files: string[]; conflict?: string }> {
		return withLock(this.projectId, async () => {
			const dir = await this.ensureWorktree(agentKey);
			await git(dir, ["add", "-A"]);
			const staged = (await git(dir, ["diff", "--cached", "--name-only"])).trim();
			if (staged) await git(dir, ["commit", "-q", "-m", message]);
			try {
				await git(dir, ["merge", "-q", "--no-edit", "main"]);
			} catch (e) {
				const conflicted = (await git(dir, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim();
				await git(dir, ["merge", "--abort"]).catch(() => {});
				return { merged: false, files: [], conflict: `Merging main into your branch conflicts in: ${conflicted || (e as Error).message}. Run \`git merge main\` in your worktree, resolve the conflicts, commit, and publish again.` };
			}
			const ahead = (await git(this.main, ["rev-list", "--count", `main..${this.branch(agentKey)}`])).trim();
			if (ahead === "0") return { merged: false, files: [] };
			const files = (await git(this.main, ["diff", "--name-only", `main...${this.branch(agentKey)}`])).trim().split("\n").filter(Boolean);
			await git(this.main, ["merge", "-q", "--no-ff", "-m", `${message} (${agentKey})`, this.branch(agentKey)]);
			const commit = (await git(this.main, ["rev-parse", "--short", "HEAD"])).trim();
			return { merged: true, commit, files };
		});
	}

	/** Bring `main` into the agent's worktree (its own commits stay). */
	sync(agentKey: string): Promise<string> {
		return withLock(this.projectId, () => this.#sync(agentKey));
	}

	async #sync(agentKey: string): Promise<string> {
		const dir = await this.ensureWorktree(agentKey);
		await git(dir, ["add", "-A"]);
		if ((await git(dir, ["diff", "--cached", "--name-only"])).trim()) await git(dir, ["commit", "-q", "-m", "Work in progress"]);
		try {
			return (await git(dir, ["merge", "--no-edit", "main"])).trim() || "Up to date with main.";
		} catch (e) {
			const conflicted = (await git(dir, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim();
			return `Conflicts in: ${conflicted}. Resolve them in your worktree and commit. (${(e as Error).message.split("\n")[0]})`;
		}
	}

	/**
	 * A developer hands in a task: commit the worktree and merge the latest `main` into the branch, so
	 * what gets reviewed is exactly what would land. Returns the commit to review and merge, the files it
	 * changes against `main`, or the conflict for the developer to resolve.
	 */
	submit(agentKey: string, message: string): Promise<{ commit?: string; files: string[]; conflict?: string }> {
		return withLock(this.projectId, async () => {
			const dir = await this.ensureWorktree(agentKey);
			await git(dir, ["add", "-A"]);
			if ((await git(dir, ["diff", "--cached", "--name-only"])).trim()) await git(dir, ["commit", "-q", "-m", message]);
			try {
				await git(dir, ["merge", "-q", "--no-edit", "main"]);
			} catch (e) {
				const conflicted = (await git(dir, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim();
				await git(dir, ["merge", "--abort"]).catch(() => {});
				return { files: [], conflict: `Merging the latest main into your branch conflicts in: ${conflicted || (e as Error).message}. Run \`git merge main\` in your worktree, resolve the conflicts, commit, and call task_done again.` };
			}
			const commit = (await git(dir, ["rev-parse", "HEAD"])).trim();
			const files = (await git(this.main, ["diff", "--name-only", `main...${commit}`])).trim().split("\n").filter(Boolean);
			return { commit, files };
		});
	}

	/** Merge a reviewed commit into `main` (no-ff, so main's first-parent history reads one entry per task). */
	mergeCommit(commit: string, message: string): Promise<{ commit?: string; files: string[]; conflict?: string }> {
		return withLock(this.projectId, async () => {
			const files = (await git(this.main, ["diff", "--name-only", `main...${commit}`])).trim().split("\n").filter(Boolean);
			if ((await git(this.main, ["rev-list", "--count", `main..${commit}`])).trim() === "0") return { commit: await this.head(), files: [] };
			try {
				await git(this.main, ["merge", "-q", "--no-ff", "-m", message, commit]);
			} catch (e) {
				const conflicted = (await git(this.main, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim();
				await git(this.main, ["merge", "--abort"]).catch(() => {});
				return { files: [], conflict: conflicted || (e as Error).message.split("\n")[0] };
			}
			return { commit: await this.head(), files };
		});
	}

	/**
	 * Put a commit in an agent's worktree, detached (the reviewer reads and tests exactly what was
	 * submitted). Its own uncommitted changes are discarded; ignored files (node_modules) stay.
	 */
	async checkoutDetached(agentKey: string, commit: string) {
		const dir = await this.ensureWorktree(agentKey);
		await git(dir, ["reset", "-q", "--hard"]);
		await git(dir, ["clean", "-fdq"]);
		await git(dir, ["checkout", "-q", "--detach", commit]);
	}

	/** True when the worktree holds a detached commit (code under review) instead of its own branch. */
	async isDetached(agentKey: string) {
		return !(await git(this.worktree(agentKey), ["symbolic-ref", "-q", "HEAD"]).then(
			(s) => s.trim(),
			() => "",
		));
	}

	/** Back to the agent's own branch after a review. */
	async checkoutOwnBranch(agentKey: string) {
		const dir = await this.ensureWorktree(agentKey);
		if (!(await this.isDetached(agentKey))) return;
		await git(dir, ["reset", "-q", "--hard"]);
		await git(dir, ["clean", "-fdq"]);
		await git(dir, ["checkout", "-q", this.branch(agentKey)]);
	}

	/** The live preview's own checkout of `main` (detached), so running the app never touches anyone's tree. */
	get previewDir() {
		return join(this.root, "preview");
	}

	/** Update the preview checkout to `main`'s HEAD; returns that commit. Ignored files (node_modules) stay. */
	updatePreview(): Promise<string> {
		return withLock(this.projectId, async () => {
			const dir = this.previewDir;
			if (!existsSync(join(dir, ".git"))) {
				await git(this.main, ["worktree", "prune"]).catch(() => {});
				await git(this.main, ["worktree", "add", "-q", "--detach", dir, "main"]);
			} else {
				await git(dir, ["reset", "-q", "--hard"]);
				await git(dir, ["clean", "-fdq"]);
				await git(dir, ["checkout", "-q", "--detach", "main"]);
			}
			return (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
		});
	}

	/**
	 * Store the user's uploads in `attachments/` (outside git). Never overwrites: a name taken by
	 * different content gets a numbered suffix. Returns the stored file names.
	 */
	addAttachments(files: { name: string; bytes: Buffer }[]): string[] {
		const dir = this.attachmentsDir;
		mkdirSync(dir, { recursive: true });
		return files.map((f) => {
			const safe = f.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "file";
			const dot = safe.lastIndexOf(".");
			const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
			let name = safe;
			for (let i = 2; existsSync(join(dir, name)) && !readFileSync(join(dir, name)).equals(f.bytes); i++) name = `${stem}-${i}${ext}`;
			writeFileSync(join(dir, name), f.bytes);
			return name;
		});
	}

	/** pi-os's own file on `main` (e.g. docs/backlog.md): written and committed if it changed. */
	writeMain(path: string, content: string, message: string): Promise<boolean> {
		return withLock(this.projectId, async () => {
			const file = join(this.main, path);
			if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, content);
			await git(this.main, ["add", "--", path]);
			if (!(await git(this.main, ["diff", "--cached", "--name-only"])).trim()) return false;
			await git(this.main, ["commit", "-q", "-m", message]);
			return true;
		});
	}

	// ---------------------------------------------------------------- reads of main (for the UI)

	async files(): Promise<string[]> {
		return (await git(this.main, ["ls-tree", "-r", "--name-only", "HEAD"])).split("\n").filter(Boolean);
	}

	/** A file at `main`'s HEAD; undefined if it doesn't exist. */
	async read(path: string): Promise<{ text?: string; binary?: boolean; size: number } | undefined> {
		if (!/^[^\0]+$/.test(path) || path.startsWith("/") || path.split("/").includes("..")) throw new GitError("Bad path");
		const sizeOut = await git(this.main, ["cat-file", "-s", `HEAD:${path}`]).catch(() => undefined);
		if (sizeOut === undefined) return undefined;
		const size = Number(sizeOut.trim());
		if (size > 2 * 1024 * 1024) return { binary: true, size };
		const text = await git(this.main, ["show", `HEAD:${path}`]);
		return text.includes("\u0000") ? { binary: true, size } : { text, size };
	}

	async log(limit = 50): Promise<{ hash: string; subject: string; at: number; files: number }[]> {
		const out = await git(this.main, ["log", `-${limit}`, "--first-parent", "--diff-merges=first-parent", "--format=%x1e%h%x1f%s%x1f%ct", "--shortstat"]);
		return out
			.split("\u001e")
			.filter((s) => s.trim())
			.map((chunk) => {
				const [head, stat] = chunk.split("\n").filter(Boolean) as [string, string?];
				const [hash, subject, ct] = head.split("\u001f");
				return { hash: hash!, subject: subject!, at: Number(ct) * 1000, files: Number(/(\d+) files? changed/.exec(stat ?? "")?.[1] ?? 0) };
			});
	}

	async head(): Promise<string> {
		return (await git(this.main, ["rev-parse", "--short", "HEAD"])).trim();
	}
}
