import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewStore } from "../server/store.mjs";
import { ReviewJobs } from "../server/review-jobs.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "review-collection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcripts = join(root, "transcripts");
  await mkdir(transcripts);
  const store = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  const changeSet = {
    kind: "github-pr",
    source: "example/repo",
    id: "1",
    url: "https://github.com/example/repo/pull/1",
    revision: "a:b",
  };
  const file = await store.create({
    file: "changes/github/example-repo/pr-1/a-b/src/test.ts",
    before: "old",
    content: "new",
    readOnly: true,
    changeSet,
  });
  const result = {
    files: {
      "src/test.ts": [
        { heading: "確認", review: "検証済み", severity: "info" },
      ],
    },
  };
  const answer = async (
    content = { result: JSON.stringify(result) },
    url = changeSet.url,
  ) =>
    writeFile(
      join(transcripts, "session_1.jsonl"),
      [
        {
          role: "user",
          content: `GitHub PR ${url} をコードレビューしてください。`,
        },
        { role: "assistant", content },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
  return { root, store, transcripts, changeSet, file, answer };
}

test("browser disconnect and extension restart do not lose the completed review", async (t) => {
  const f = await fixture(t);
  const first = await new ReviewJobs(f.store, f.transcripts).init();
  await first.register(f.changeSet, "session_1");
  await first.collect();
  assert.equal(first.list()[0].status, "running");
  // No browser applyAnalysis request is made. The persisted answer arrives later.
  await f.answer();
  const resumed = await new ReviewJobs(f.store, f.transcripts).init();
  assert.equal(resumed.list()[0].status, "completed");
  assert.equal(
    (await f.store.get(f.file.id)).explanations[0].review,
    "検証済み",
  );
  assert.deepEqual(resumed.list()[0].result, { updated: 1, total: 1 });
  await resumed.collect();
  assert.equal(resumed.list().length, 1);
});

test("saving imported text rejects in-flight review output and permits a fresh review", async (t) => {
  const f = await fixture(t);
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  await jobs.register(f.changeSet, "session_1");
  await f.store.save(f.file.id, "edited source");
  await f.answer();
  await jobs.collect();
  assert.equal(jobs.list()[0].status, "failed");
  assert.equal((await f.store.get(f.file.id)).explanations.length, 0);
  const current = (await f.store.get(f.file.id)).changeSet;
  assert.ok(current.editRevision);
  const next = await jobs.register(current, "session_2");
  assert.equal(next.status, "running");
  assert.equal(next.changeSet.editRevision, current.editRevision);
  await f.store.applyImportAnalysis(current, {
    "src/test.ts": [{ heading: "fresh", review: "edited source checked" }],
  });
  assert.equal((await f.store.get(f.file.id)).explanations[0].heading, "fresh");
  await f.store.updateImported(f.file.file, {
    changeSet: f.changeSet,
    explanations: [{ heading: "old" }],
  });
  assert.equal(
    (await f.store.get(f.file.id)).changeSet.editRevision,
    current.editRevision,
  );
  assert.equal((await f.store.get(f.file.id)).explanations[0].heading, "fresh");
});

test("file review accepts only the selected file and keeps its conversation", async (t) => {
  const f = await fixture(t);
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  await assert.rejects(
    jobs.register(f.changeSet, "wrong", undefined, "src/missing.ts"),
    { status: 400 },
  );
  await jobs.register(f.changeSet, "session_1", undefined, f.file.file);
  await f.answer({
    result: JSON.stringify({
      files: { "src/other.ts": [{ heading: "別ファイル" }] },
    }),
  });
  await jobs.collect();
  assert.equal(jobs.list()[0].status, "failed");
  assert.equal(jobs.list()[0].sessionId, "session_1");
  assert.equal((await f.store.get(f.file.id)).explanations.length, 0);
});

test("concurrent registrations reuse the running job", async (t) => {
  const f = await fixture(t);
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  const results = await Promise.all([
    jobs.register(f.changeSet, "session_1"),
    jobs.register(f.changeSet, "session_2"),
  ]);
  assert.equal(results[0].sessionId, results[1].sessionId);
  assert.equal(jobs.list().length, 1);
  await assert.rejects(jobs.register(f.changeSet, "../other"), { status: 400 });
});

test("stale PR revision results fail without changing current explanations", async (t) => {
  const f = await fixture(t);
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  await jobs.register(f.changeSet, "session_1");
  f.store.reviews[0].changeSet = { ...f.changeSet, revision: "a:c" };
  await f.answer();
  await jobs.collect();
  assert.equal(jobs.list()[0].status, "failed");
  assert.match(jobs.list()[0].error, /対象の版またはレビュー指示/);
  assert.equal((await f.store.get(f.file.id)).explanations.length, 0);
});

test("invalid output is persisted as failure and can be retried with a new session", async (t) => {
  const f = await fixture(t);
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  await jobs.register(f.changeSet, "session_1");
  await f.answer({ result: "not JSON" });
  await jobs.collect();
  const restarted = await new ReviewJobs(f.store, f.transcripts).init();
  assert.equal(restarted.list()[0].status, "failed");
  assert.equal(
    (await restarted.register(f.changeSet, "session_2")).status,
    "running",
  );
});

test("unstarted conversation times out and unrelated session cannot be applied", async (t) => {
  const f = await fixture(t);
  let now = 0;
  const jobs = await new ReviewJobs(f.store, f.transcripts, {
    now: () => now,
  }).init();
  await jobs.register(f.changeSet, "session_1");
  now = 120001;
  await jobs.collect();
  assert.equal(jobs.list()[0].status, "failed");
  await jobs.register(f.changeSet, "session_2");
  await f.answer(undefined, "https://github.com/other/repo/pull/2");
  await writeFile(
    join(f.transcripts, "session_2.jsonl"),
    await (
      await import("node:fs/promises")
    ).readFile(join(f.transcripts, "session_1.jsonl")),
  );
  await jobs.collect();
  assert.match(jobs.list()[1].error, /対象が一致/);
});

test("transcript symlink outside the configured directory is rejected", async (t) => {
  const f = await fixture(t);
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  await jobs.register(f.changeSet, "session_1");
  await writeFile(join(f.root, "outside"), "{}");
  await symlink(
    join(f.root, "outside"),
    join(f.transcripts, "session_1.jsonl"),
  );
  await jobs.collect();
  assert.equal(jobs.list()[0].status, "failed");
  assert.match(jobs.list()[0].error, /保存先/);
});

test("independent reviewers retain both results across restart; one failure does not discard another", async (t) => {
  const f = await fixture(t);
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  const a = { id: "reviewer-a", name: "Reviewer A" },
    b = { id: "reviewer-b", name: "Reviewer B" };
  await jobs.register(f.changeSet, "review_a", a);
  await jobs.register(f.changeSet, "review_b", b);
  assert.equal(jobs.list().length, 2);
  assert.equal(
    (await jobs.register(f.changeSet, "duplicate_a", a)).sessionId,
    "review_a",
  );
  const answer = async (id, text) =>
    writeFile(
      join(f.transcripts, `${id}.jsonl`),
      [
        JSON.stringify({ role: "user", content: f.changeSet.url }),
        JSON.stringify({ role: "assistant", content: text }),
      ].join("\n"),
    );
  await answer(
    "review_b",
    JSON.stringify({
      files: { "src/test.ts": [{ heading: "B finding", review: "B result" }] },
    }),
  );
  await jobs.collect();
  assert.equal(jobs.list()[0].status, "running");
  assert.equal(jobs.list()[1].status, "completed");
  await answer(
    "review_a",
    JSON.stringify({
      files: { "src/test.ts": [{ heading: "A finding", review: "A result" }] },
    }),
  );
  const resumed = await new ReviewJobs(f.store, f.transcripts).init();
  assert.ok(resumed.list().every((j) => j.status === "completed"));
  const explanations = (await f.store.get(f.file.id)).explanations;
  assert.equal(explanations.length, 2);
  assert.match(explanations[0].heading, /Reviewer A/);
  assert.match(explanations[1].heading, /Reviewer B/);
  await resumed.register(f.changeSet, "failed_a", a);
  await answer("failed_a", "invalid");
  await resumed.collect();
  assert.equal(resumed.list().at(-1).status, "failed");
  assert.deepEqual((await f.store.get(f.file.id)).explanations, explanations);
});

const legacyError =
  "AIレビューの結果を読み取れませんでした。xangi会話で結果を確認してください。";
async function legacyFailure(f) {
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  const job = await jobs.register(f.changeSet, "session_1");
  job.status = "failed";
  job.error = legacyError;
  await jobs.persist();
}
test("旧読取失敗は起動時に保存済み回答から自動復旧する", async (t) => {
  const f = await fixture(t);
  await legacyFailure(f);
  await f.answer(
    JSON.stringify({
      files: {
        "src/test.ts": { heading: "確認", review: "正常", severity: "info" },
      },
    }) + '\n{"to":"noise"}}',
  );
  const recovered = await new ReviewJobs(f.store, f.transcripts).init();
  assert.equal(recovered.list()[0].status, "completed");
  assert.equal(recovered.list()[0].result.updated, 1);
  assert.equal(recovered.list()[0].error, undefined);
});
test("途切れた回答は理由を更新し再起動でも再処理しない", async (t) => {
  const f = await fixture(t);
  await legacyFailure(f);
  await f.answer('{"files":{');
  const failed = await new ReviewJobs(f.store, f.transcripts).init();
  assert.equal(failed.list()[0].status, "failed");
  assert.match(failed.list()[0].error, /途中で途切れ/);
  const finishedAt = failed.list()[0].finishedAt;
  await f.answer();
  await failed.collect();
  const restarted = await new ReviewJobs(f.store, f.transcripts).init();
  assert.equal(restarted.list()[0].status, "failed");
  assert.equal(restarted.list()[0].finishedAt, finishedAt);
});
test("自動復旧でも旧版の回答を反映せず、無関係な失敗を再処理しない", async (t) => {
  const f = await fixture(t);
  await legacyFailure(f);
  f.store.reviews[0].changeSet = { ...f.changeSet, revision: "a:c" };
  await f.answer();
  const failed = await new ReviewJobs(f.store, f.transcripts).init();
  assert.equal(failed.list()[0].status, "failed");
  assert.match(failed.list()[0].error, /対象の版またはレビュー指示/);
  assert.equal((await f.store.get(f.file.id)).explanations.length, 0);
  f.store.reviews[0].changeSet = f.changeSet;
  const restarted = await new ReviewJobs(f.store, f.transcripts).init();
  assert.equal(restarted.list()[0].status, "failed");
});

test("whole-review overview persists with its revision; file reviews cannot replace it", async (t) => {
  const f = await fixture(t);
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  const overview = {
    summary: "全体の目的",
    before: "変更前",
    after: "変更後",
    nodes: [
      {
        id: "test",
        label: "テスト",
        description: "動作を確認",
        files: ["src/test.ts"],
      },
    ],
    edges: [],
    decisions: [],
    limitations: ["実行していない"],
  };
  const files = { "src/test.ts": [{ heading: "確認", review: "確認" }] };
  await jobs.register(f.changeSet, "session_1");
  await f.answer({ result: JSON.stringify({ files, overview }) });
  await jobs.collect();
  assert.equal(jobs.list()[0].status, "completed");
  const saved = (await f.store.get(f.file.id)).softwareOverview;
  assert.equal(saved.revision, f.changeSet.revision);
  const resumed = await new ReviewStore(f.store.root, f.store.stateDir).init();
  assert.equal(
    (await resumed.get(f.file.id)).softwareOverview.summary,
    "全体の目的",
  );
  await f.store.applyImportAnalysis(f.changeSet, files);
  assert.deepEqual((await f.store.get(f.file.id)).softwareOverview, saved);
  await f.store.setImportReviewContext({
    ...f.changeSet,
    reviewContext: "別の観点",
  });
  assert.deepEqual((await f.store.get(f.file.id)).softwareOverview, saved);
  await assert.rejects(
    f.store.applyImportAnalysis(f.changeSet, files, undefined, overview),
    { status: 409 },
  );
});

test("invalid overview does not partially apply file results", async (t) => {
  const f = await fixture(t);
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  await jobs.register(f.changeSet, "session_1");
  await f.answer({
    result: JSON.stringify({
      files: { "src/test.ts": [{ heading: "new", review: "new" }] },
      overview: { summary: "incomplete" },
    }),
  });
  await jobs.collect();
  assert.equal(jobs.list()[0].status, "failed");
  assert.equal((await f.store.get(f.file.id)).explanations.length, 0);
});

test("file-only jobs ignore supplied global overview", async (t) => {
  const f = await fixture(t);
  const jobs = await new ReviewJobs(f.store, f.transcripts).init();
  await jobs.register(f.changeSet, "session_1", undefined, f.file.file);
  await f.answer({
    result: JSON.stringify({
      files: { "src/test.ts": [{ heading: "file", review: "file" }] },
      overview: { summary: "not a global review" },
    }),
  });
  await jobs.collect();
  assert.equal(jobs.list()[0].status, "completed");
  assert.equal((await f.store.get(f.file.id)).softwareOverview, undefined);
});
