// Pure unified-diff parsing. No pi imports, so it is testable with plain node.

export interface Hunk {
	header: string; // "@@ -1,3 +1,4 @@ ..."
	lines: string[]; // body lines, each starting with ' ', '+', '-' or '\'
}
export interface FileDiff {
	path: string;
	added: number;
	removed: number;
	/** true for binary files, pure renames, mode changes: no hunks to select */
	hunks: Hunk[];
	note?: string;
}

/** Parse the output of `gh pr diff` (git unified format) into files and hunks. */
export function parseDiff(text: string): FileDiff[] {
	const files: FileDiff[] = [];
	let file: FileDiff | undefined;
	let hunk: Hunk | undefined;
	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		if (raw.startsWith("diff --git ")) {
			// "diff --git a/x b/x" - take the b/ side (handles renames; quoted names are unquoted below)
			const m = raw.match(/^diff --git "?a\/.*?"? "?b\/(.*?)"?$/);
			file = { path: m ? m[1] : raw.slice(11), added: 0, removed: 0, hunks: [] };
			files.push(file);
			hunk = undefined;
		} else if (!file) {
			continue;
		} else if (raw.startsWith("@@")) {
			hunk = { header: raw, lines: [] };
			file.hunks.push(hunk);
		} else if (hunk) {
			if (raw === "") continue; // trailing blank from split
			hunk.lines.push(raw);
			if (raw[0] === "+") file.added++;
			else if (raw[0] === "-") file.removed++;
		} else if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
			file.note = "binary file";
		} else if (raw.startsWith("rename from ")) {
			file.note = `renamed from ${raw.slice(12)}`;
		} else if (raw.startsWith("new mode") || raw.startsWith("old mode")) {
			file.note ??= "mode change";
		}
	}
	return files;
}

export function hunkText(h: Hunk): string {
	return [h.header, ...h.lines].join("\n");
}

/** The prompt sent to the model for a selected hunk. */
export function buildPrompt(opts: { pr: number; title: string; path: string; hunk: Hunk; comment: string }): string {
	return [
		`Change suggestion for PR #${opts.pr} (${opts.title}).`,
		`File: ${opts.path}`,
		"",
		"Hunk:",
		"```diff",
		hunkText(opts.hunk),
		"```",
		"",
		`Comment: ${opts.comment}`,
	].join("\n");
}
