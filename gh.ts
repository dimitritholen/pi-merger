// Thin wrapper over the `gh` CLI. Only source of PR data. Errors are turned into readable messages.

export interface PR {
	number: number;
	title: string;
	author: { login: string };
	headRefName: string;
	baseRefName: string;
	isDraft: boolean;
}

export type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export class GhError extends Error {}

async function run(exec: Exec, args: string[]): Promise<string> {
	let r;
	try {
		r = await exec("gh", args);
	} catch (e) {
		// spawn failure: binary not on PATH
		throw new GhError("`gh` was not found. Install the GitHub CLI: https://cli.github.com");
	}
	if (r.code === 0) return r.stdout;
	const err = (r.stderr || r.stdout).trim();
	if (r.code === 127 || /command not found|ENOENT/.test(err))
		throw new GhError("`gh` was not found. Install the GitHub CLI: https://cli.github.com");
	if (/gh auth login|not logged in|authentication|GH_TOKEN/i.test(err))
		throw new GhError("`gh` is not authenticated. Run `gh auth login` in a terminal, then press r.");
	throw new GhError(`gh ${args.slice(0, 2).join(" ")} failed (exit ${r.code}): ${err || "no output"}`);
}

export async function listPRs(exec: Exec): Promise<PR[]> {
	const out = await run(exec, [
		"pr", "list", "--state", "open", "--limit", "100",
		"--json", "number,title,author,headRefName,baseRefName,isDraft",
	]);
	try {
		return JSON.parse(out) as PR[];
	} catch {
		throw new GhError("could not parse `gh pr list` output");
	}
}

export const prDiff = (exec: Exec, n: number) => run(exec, ["pr", "diff", String(n), "--color", "never"]);

export const approvePR = (exec: Exec, n: number) => run(exec, ["pr", "review", String(n), "--approve"]);
