import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../server/store.mjs";
import { ReviewJobs } from "../server/review-jobs.mjs";
import {
  parseGitHubRepository,
  importGitHubRepository,
} from "../server/github-repository.mjs";
import {
  buildAutoReviewPrompt,
  buildFileReviewPrompt,
} from "../shared/auto-review.mjs";
import { createServer } from "../server/http.mjs";
const url = "https://github.com/example/repo";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "repo-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new ReviewStore(
    join(dir, "files"),
    join(dir, "state"),
  ).init();
  const state = {
    sha: "a".repeat(40),
    truncated: false,
    fail: false,
    entries: [
      {
        path: "src/main.ts",
        type: "blob",
        mode: "100644",
        size: 20,
        sha: "blob",
      },
      { path: ".env", type: "blob", mode: "100644", size: 0, sha: "empty" },
    ],
  };
  const calls = [];
  const github = {
    json: async (path) => {
      calls.push(path);
      if (path.endsWith("/repo")) return { default_branch: "main" };
      if (path.includes("/commits/")) return { sha: state.sha };
      if (path.includes("/trees/"))
        return { tree: state.entries, truncated: state.truncated };
      if (state.fail) throw new Error("fetch failed");
      return {
        encoding: "base64",
        content: Buffer.from(
          path.endsWith("/empty") ? "" : "export const n = 1;\n",
        ).toString("base64"),
      };
    },
  };
  return { dir, store, state, github, calls };
}
test("repository URL, .git and slash-containing refs; invalid routes rejected", () => {
  assert.deepEqual(parseGitHubRepository(url + ".git/"), {
    owner: "example",
    repo: "repo",
    ref: undefined,
  });
  assert.equal(
    parseGitHubRepository(url + "/tree/feature%2Fone").ref,
    "feature/one",
  );
  for (const invalid of [
    url + "/pull/1",
    "https://evil.com/example/repo",
    url + "?x=1",
    url + "/tree/%zz",
  ])
    assert.throws(() => parseGitHubRepository(invalid));
});
test("snapshot pins SHA, includes empty/dot files, reimport preserves reviews and applies context", async (t) => {
  const f = await fixture(t);
  const first = await importGitHubRepository(f.store, url, {}, f.github);
  assert.equal(first.imported.length, 2);
  assert.equal(first.changeSet.kind, "github-repository");
  assert.ok(f.calls.some((p) => p.includes(`/trees/${f.state.sha}?`)));
  assert.equal((await f.store.get(first.imported[1].id)).content, "");
  await f.store.applyImportAnalysis(first.changeSet, {
    "src/main.ts": [{ heading: "review", review: "checked", severity: "info" }],
  });
  const second = await importGitHubRepository(f.store, url, {}, f.github);
  assert.equal(second.status, "unchanged");
  assert.equal(second.imported[0].id, first.imported[0].id);
  assert.equal(
    (await f.store.get(first.imported[0].id)).explanations[0].review,
    "checked",
  );
  const context = await importGitHubRepository(
    f.store,
    url,
    {},
    f.github,
    "security",
  );
  assert.equal(context.status, "updated");
  await assert.rejects(
    f.store.applyImportAnalysis(first.changeSet, {
      "src/main.ts": [{ heading: "stale" }],
    }),
    { status: 409 },
  );
});
test("partial update keeps previous revision; retry fills missing files and supersedes", async (t) => {
  const f = await fixture(t);
  await importGitHubRepository(f.store, url, {}, f.github);
  f.state.sha = "b".repeat(40);
  f.state.fail = true;
  const failed = await importGitHubRepository(f.store, url, {}, f.github);
  assert.equal(failed.skipped.length, 2);
  assert.equal(f.store.list().length, 2);
  f.state.fail = false;
  f.state.entries = f.state.entries.slice(0, 1);
  const latest = await importGitHubRepository(f.store, url, {}, f.github);
  assert.equal(latest.imported.length, 1);
  assert.equal(f.store.list().length, 1);
  assert.equal(f.store.list()[0].changeSet.revision, f.state.sha);
});
test("truncated tree and oversized list reject before saving; symlinks and large blobs skip", async (t) => {
  const f = await fixture(t);
  f.state.truncated = true;
  await assert.rejects(importGitHubRepository(f.store, url, {}, f.github), {
    status: 413,
  });
  assert.equal(f.store.list().length, 0);
  f.state.truncated = false;
  f.state.entries = Array(3001).fill(f.state.entries[0]);
  await assert.rejects(importGitHubRepository(f.store, url, {}, f.github), {
    status: 413,
  });
  f.state.entries = [
    { path: "link", type: "blob", mode: "120000" },
    { path: "large", type: "blob", mode: "100644", size: 300000 },
  ];
  assert.equal(
    (await importGitHubRepository(f.store, url, {}, f.github)).skipped.length,
    2,
  );
});
test("repository file review survives collection and prompts request pinned content", async (t) => {
  const f = await fixture(t);
  const result = await importGitHubRepository(f.store, url, {}, f.github);
  const file = result.imported[0];
  const logs = join(f.dir, "logs");
  await mkdir(logs);
  const jobs = await new ReviewJobs(f.store, logs).init();
  await jobs.register(result.changeSet, "repo_session", undefined, file.file);
  await writeFile(
    join(logs, "repo_session.jsonl"),
    [
      { role: "user", content: url },
      {
        role: "assistant",
        content: JSON.stringify({
          files: {
            "src/main.ts": [
              { heading: "code", review: "verified", severity: "info" },
            ],
          },
        }),
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  await jobs.collect();
  assert.equal(jobs.list()[0].status, "completed");
  assert.equal((await f.store.get(file.id)).explanations[0].review, "verified");
  for (const prompt of [
    buildAutoReviewPrompt(url, ["src/main.ts"], "", result.changeSet),
    buildFileReviewPrompt(url, "src/main.ts", "", result.changeSet),
  ]) {
    assert.ok(prompt.includes(f.state.sha));
    assert.match(prompt, /ファイル内容/);
  }
});
test("HTTP entry accepts repository and completes asynchronous job", async (t) => {
  const f = await fixture(t);
  const server = createServer({
    store: f.store,
    token: "test",
    distDir: "dist",
    importRepository: (store, url, analysis, _github, context) =>
      importGitHubRepository(store, url, analysis, f.github, context),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    "content-type": "application/json",
    authorization: "Bearer test",
  };
  const response = await fetch(base + "/api/import/github", {
    method: "POST",
    headers,
    body: JSON.stringify({ url }),
  });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  let job;
  for (let n = 0; n < 100; n++) {
    job = await (
      await fetch(base + `/api/import/github/jobs/${id}`, { headers })
    ).json();
    if (job.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(job.status, "completed");
  assert.equal(job.result.imported.length, 2);
});

test("repository UI keys separate partial revisions and support non-JS source files", async (t) => {
  const { githubGroupKey } = await import("../shared/pr-label.mjs");
  const f = await fixture(t);
  f.state.entries[0].path = "src/main.rs";
  const first = await importGitHubRepository(f.store, url, {}, f.github);
  assert.equal(first.imported.length, 2);
  f.state.sha = "c".repeat(40);
  const originalJson = f.github.json;
  f.github.json = async (p) => {
    if (p.endsWith("/empty")) throw new Error("read failed");
    return originalJson(p);
  };
  const second = await importGitHubRepository(f.store, url, {}, f.github);
  assert.equal(second.imported.length, 1);
  assert.equal(second.skipped.length, 1);
  assert.notEqual(
    githubGroupKey(first.changeSet),
    githubGroupKey(second.changeSet),
  );
  assert.equal(f.store.list().length, 3);
});

test("reimport after an edit preserves the copy and still accepts a new review context", async (t) => {
  const f = await fixture(t);
  const first = await importGitHubRepository(f.store, url, {}, f.github);
  const item = first.imported[0];
  const saved = await f.store.save(item.id, "edited repository copy");
  const next = await importGitHubRepository(
    f.store,
    url,
    {},
    f.github,
    "new context",
  );
  assert.equal(next.imported[0].id, item.id);
  const current = await f.store.get(item.id);
  assert.equal(current.content, "edited repository copy");
  assert.equal(current.changeSet.editRevision, saved.changeSet.editRevision);
  assert.equal(current.changeSet.reviewContext, "new context");
});
