import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findRepos, settleAll } from "./repos.ts";

test("finds direct subfolder repos, skips hidden/node_modules/non-repos", () => {
	const root = mkdtempSync(join(tmpdir(), "merger-"));
	for (const d of ["b/.git", "a/.git", "plain", "node_modules/x/.git", ".hid/.git"]) mkdirSync(join(root, d), { recursive: true });
	assert.deepEqual(findRepos(root).map((r) => r.name), ["a", "b"]);
	mkdirSync(join(root, ".git"));
	assert.equal(findRepos(root).length, 3); // the start folder itself counts too
});

test("settleAll keeps order and captures failures", async () => {
	const r = await settleAll([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("x"); return n; });
	assert.deepEqual(r.map((x) => x.status), ["fulfilled", "rejected", "fulfilled"]);
});
