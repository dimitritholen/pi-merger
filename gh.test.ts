import assert from "node:assert/strict";
import { test } from "node:test";
import { approvePR, listPRs, mergePR } from "./gh.ts";

const fail = (stderr: string, code = 1) => async () => ({ stdout: "", stderr, code });

test("gh missing (spawn failure and exit 127)", async () => {
	await assert.rejects(listPRs(async () => { throw new Error("spawn gh ENOENT"); }), /not found/);
	await assert.rejects(listPRs(fail("gh: command not found", 127)), /not found/);
});

test("not authenticated", async () => {
	await assert.rejects(listPRs(fail("To get started with GitHub CLI, please run:  gh auth login", 4)), /not authenticated/);
});

test("other failures keep gh's message", async () => {
	await assert.rejects(approvePR(fail("Review Can not approve your own pull request"), 3), /own pull request/);
});

test("merge always passes an explicit method flag", async () => {
	let args: string[] = [];
	await mergePR(async (_c, a) => { args = a; return { stdout: "", stderr: "", code: 0 }; }, 9, "rebase");
	assert.deepEqual(args, ["pr", "merge", "9", "--rebase"]);
});
