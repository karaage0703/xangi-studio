import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeReviewContext } from "../shared/review-context.mjs";
import { buildAutoReviewPrompt } from "../shared/auto-review.mjs";
import { ReviewStore } from "../server/store.mjs";
import { ReviewJobs } from "../server/review-jobs.mjs";
import { createServer } from "../server/http.mjs";

test("optional context is bounded text and included before output requirements", () => {
  assert.equal(normalizeReviewContext(undefined), undefined);
  assert.equal(normalizeReviewContext(" \n"), "");
  for (const value of [null, {}, 123, "a".repeat(12001)])
    assert.throws(() => normalizeReviewContext(value), { status: 400 });
  const prompt = buildAutoReviewPrompt(
    "https://github.com/a/b/pull/1",
    ["test.ts"],
    "参考資料：仕様A",
  );
  assert.match(prompt, /参考資料：仕様A/);
  assert.ok(prompt.indexOf("参考資料：仕様A") < prompt.indexOf("結果は説明文"));
  assert.doesNotMatch(buildAutoReviewPrompt("url", []), /利用者がこの取り込み/);
});

test("context changes persist, reset results, isolate jobs and reject stale registration/results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  const changeSet = {
    kind: "github-pr",
    id: "1",
    source: "a/b",
    url: "https://github.com/a/b/pull/1",
    revision: "a:b",
    reviewContext: "first",
  };
  const item = await store.create({
    file: "changes/github/a-b/pr-1/a-b/test.ts",
    before: "a",
    content: "b",
    readOnly: true,
    changeSet,
  });
  const jobs = await new ReviewJobs(store, root).init();
  const first = await jobs.register(changeSet, "first");
  await store.applyImportAnalysis(
    changeSet,
    { "test.ts": [{ review: "old" }] },
    { id: "reviewer", name: "Reviewer" },
  );
  const next = { ...changeSet, reviewContext: "second" };
  await store.setImportReviewContext(next);
  await assert.rejects(jobs.register(changeSet, "stale"), { status: 409 });
  const second = await jobs.register(next, "second");
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(first.changeSet.reviewContext, "first");
  await assert.rejects(
    store.applyImportAnalysis(changeSet, { "test.ts": [{ review: "stale" }] }),
    { status: 409 },
  );
  const reopened = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  assert.equal(reopened.find(item.id).changeSet.reviewContext, "second");
  assert.deepEqual(reopened.find(item.id).reviewerResults, {});
  assert.deepEqual(reopened.find(item.id).explanations, []);
  await store.setImportReviewContext({ ...next, reviewContext: "" });
  assert.equal(store.find(item.id).changeSet.reviewContext, "");
});

test("all import APIs reject invalid context before starting work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-http-"));
  const store = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  const server = createServer({ store, token: "test", distDir: root });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  for (const path of ["github", "google", "pdf"]) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/import/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reviewContext: { invalid: true } }),
      },
    );
    assert.equal(response.status, 400, path);
    assert.match((await response.json()).error, /追加指示/);
  }
});

test("review-time context API updates the whole revision, clears instructions and rejects stale targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "action-context-"));
  const store = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  const changeSet = {
    kind: "github-pr",
    source: "a/b",
    id: "1",
    revision: "a:b",
    reviewContext: "old",
  };
  const items = await Promise.all(
    ["one.md", "two.md"].map((file) =>
      store.create({ file, content: "original", readOnly: true, changeSet }),
    ),
  );
  const server = createServer({ store, token: "test", distDir: root });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api/reviews/${items[0].id}/context`;
  const send = (body, auth = true) =>
    fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer test" } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await send({ revision: "a:b", reviewContext: "new" }, false)).status,
    401,
  );
  assert.equal(
    (await send({ revision: "old", reviewContext: "new" })).status,
    409,
  );
  assert.equal(
    (await send({ revision: "a:b", reviewContext: {} })).status,
    400,
  );
  for (const value of ["new", ""]) {
    assert.equal(
      (await send({ revision: "a:b", reviewContext: value })).status,
      200,
    );
    for (const item of items) {
      const saved = await store.get(item.id);
      assert.equal(saved.changeSet.reviewContext, value);
      assert.equal(saved.content, "original");
    }
  }
});
