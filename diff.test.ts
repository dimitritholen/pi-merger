import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt, parseDiff } from "./diff.ts";

const sample = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 keep
-old
+new
@@ -10,2 +10,3 @@ fn
 x
+added
 y
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;

test("parseDiff", () => {
	const f = parseDiff(sample);
	assert.equal(f.length, 3);
	assert.equal(f[0].path, "src/a.ts");
	assert.equal(f[0].hunks.length, 2);
	assert.deepEqual([f[0].added, f[0].removed], [2, 1]);
	assert.equal(f[1].note, "binary file");
	assert.equal(f[2].path, "new.ts");
	assert.equal(f[2].note, "renamed from old.ts");
});

test("buildPrompt contains path, hunk and comment", () => {
	const f = parseDiff(sample)[0];
	const p = buildPrompt({ pr: 7, title: "T", path: f.path, hunk: f.hunks[1], comment: "rename y" });
	assert.match(p, /src\/a\.ts/);
	assert.match(p, /@@ -10,2 \+10,3 @@ fn/);
	assert.match(p, /\+added/);
	assert.match(p, /rename y/);
});
