import test from "node:test";
import assert from "node:assert/strict";
import { listPullRequestFiles } from "../shared/github-files.mjs";

test("PRファイルを100件目以降も取得する", async () => {
  const endpoints = [];
  const files = await listPullRequestFiles(
    async (endpoint) => {
      endpoints.push(endpoint);
      return endpoints.length === 1
        ? Array.from({ length: 100 }, (_, i) => ({ filename: `${i}.ts` }))
        : [{ filename: ".env" }];
    },
    "owner",
    "repo",
    1,
  );
  assert.equal(files.length, 101);
  assert.match(endpoints[1], /page=2$/);
  assert.equal(files.at(-1).filename, ".env");
});

test("GitHubの上限に達した場合は欠落を明示する", async () => {
  await assert.rejects(
    listPullRequestFiles(
      async () => Array(100).fill({ filename: ".env" }),
      "owner",
      "repo",
      1,
    ),
    /3000ファイル/,
  );
});
