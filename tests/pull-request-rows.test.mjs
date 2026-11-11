import test from "node:test";
import assert from "node:assert/strict";
import { buildPullRequestRows } from "../shared/pull-request-rows.mjs";

test("PR差分は前後3行を残し、長い無変更部分を畳む", () => {
  const before =
    Array.from({ length: 18 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 10\n", "changed line 10\n");
  const rows = buildPullRequestRows(before, after, [
    { newStart: 10, oldStart: 10 },
  ]);
  assert.ok(rows.some((row) => row.kind === "omitted"));
  assert.ok(rows.some((row) => row.kind === "context" && row.newLine === 7));
  assert.ok(rows.some((row) => row.kind === "context" && row.newLine === 13));
  assert.deepEqual(rows.find((row) => row.kind === "added")?.comments, [0]);
});

test("削除行へのレビューは削除位置の直前に出る", () => {
  const rows = buildPullRequestRows("a\nb\nc\n", "a\nc\n", [
    { oldStart: 2, newStart: 0 },
  ]);
  assert.deepEqual(rows.find((row) => row.kind === "removed")?.comments, [0]);
});
