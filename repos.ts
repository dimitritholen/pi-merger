// Finds the git repositories pi-merger should cover: the start folder itself and its direct subfolders.
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface Repo {
	name: string;
	dir: string;
}

// shortcut: only direct subfolders are scanned (no recursion), upgrade if repos are nested deeper.
export function findRepos(cwd: string): Repo[] {
	const repos: Repo[] = [];
	if (existsSync(join(cwd, ".git"))) repos.push({ name: basename(cwd), dir: cwd });
	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = readdirSync(cwd, { withFileTypes: true });
	} catch {}
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
		const dir = join(cwd, e.name);
		if (existsSync(join(dir, ".git"))) repos.push({ name: e.name, dir });
	}
	return repos.sort((a, b) => a.name.localeCompare(b.name));
}

/** Run fn over items with at most `limit` in flight; never rejects, results keep input order. */
export async function settleAll<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
	const out: PromiseSettledResult<R>[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]).then(
				(value) => ({ status: "fulfilled", value }) as const,
				(reason) => ({ status: "rejected", reason }) as const,
			);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}
