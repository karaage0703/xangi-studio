import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewStore } from "../server/store.mjs";
import { ReviewJobs } from "../server/review-jobs.mjs";
import {
  partitionReviewFiles,
  launchReviewWork,
} from "../shared/review-plan.mjs";
import {
  buildAutoReviewPrompt,
  buildOverviewPrompt,
} from "../shared/auto-review.mjs";

const overview = {
  summary: "目的",
  before: "以前",
  after: "現在",
  nodes: [
    { id: "a", label: "入力", description: "検証する", files: ["src/a.ts"] },
  ],
  edges: [],
  decisions: [],
  limitations: ["未実行"],
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "review-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = join(root, "logs");
  await mkdir(logs);
  const store = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  const changeSet = {
    kind: "github-pr",
    source: "example/repo",
    id: "1",
    url: "https://github.com/example/repo/pull/1",
    revision: "base:head",
  };
  const files = [];
  for (const name of ["a", "b", "c"])
    files.push(
      await store.create({
        file: `changes/github/example-repo/pr-1/base-head/src/${name}.ts`,
        content: name,
        before: "old",
        readOnly: true,
        changeSet,
      }),
    );
  const jobs = await new ReviewJobs(store, logs).init();
  const answer = (id, result) =>
    writeFile(
      join(logs, id + ".jsonl"),
      [
        { role: "user", content: changeSet.url },
        { role: "assistant", content: JSON.stringify(result) },
      ]
        .map(JSON.stringify)
        .join("\n"),
    );
  return { store, jobs, logs, changeSet, files, answer };
}
test("overview and review prompts are independent and pin the imported revision", () => {
  const cs = { revision: "base:head" };
  const review = buildAutoReviewPrompt(
    "https://github.com/o/r/pull/1",
    ["src/a.ts"],
    "境界値",
    cs,
  );
  assert.doesNotMatch(review, /softwareOverview|"overview"|全体概要を返/);
  assert.match(review, /境界値/);
  assert.match(review, /base:head/);
  const summary = buildOverviewPrompt(
    "https://github.com/o/r/pull/1",
    ["src/a.ts"],
    cs,
  );
  assert.match(summary, /base:head/);
  assert.match(summary, /"overview"/);
  assert.doesNotMatch(summary, /"severity"|"files":\{/);
});
test("one reviewer still gets disjoint parallel groups; input order does not change assignment", () => {
  const files = Array.from({ length: 8 }, (_, i) => ({
    file: `src/${i}.ts`,
    content: "x".repeat((i + 1) * 100),
  }));
  const groups = partitionReviewFiles(files);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups
      .flat()
      .map((f) => f.file)
      .sort(),
    files.map((f) => f.file).sort(),
  );
  assert.deepEqual(partitionReviewFiles([...files].reverse()), groups);
  assert.deepEqual(partitionReviewFiles([]), []);
  assert.equal(partitionReviewFiles(files.slice(0, 1)).length, 1);
});
test("dispatch starts all groups without waiting for an AI answer, even with one start failure", async () => {
  let id = 0;
  const started = [];
  const result = await launchReviewWork(
    ["a", "b", "c"].map((file) => ({ file })),
    {
      createSession: async () => String(++id),
      register: async (session, work) => {
        if (work.file === "b") throw Error("offline");
        return { sessionId: session };
      },
      send: (session, work) => {
        started.push(work.file);
        return new Promise(() => {});
      },
      onJob: () => {},
      onSendError: () => {},
    },
  );
  assert.deepEqual(started.sort(), ["a", "c"]);
  assert.equal(result.filter((r) => r.status === "rejected").length, 1);
});
test("overview-only completion persists independently and preserves review results", async (t) => {
  const f = await fixture(t);
  await f.store.applyImportAnalysis(f.changeSet, {
    "src/a.ts": [{ heading: "existing", review: "keep" }],
  });
  await f.jobs.register(f.changeSet, "summary", undefined, undefined, {
    purpose: "overview",
  });
  await f.answer("summary", { overview });
  await f.jobs.collect();
  assert.equal(f.jobs.list()[0].status, "completed");
  assert.equal(
    (await f.store.get(f.files[0].id)).explanations[0].review,
    "keep",
  );
  assert.equal(
    (await f.store.get(f.files[0].id)).softwareOverview.summary,
    "目的",
  );
  const restarted = await new ReviewJobs(f.store, f.logs).init();
  assert.equal(restarted.list()[0].status, "completed");
});
test("parallel scopes for the same reviewer retain every result and reject another group's files", async (t) => {
  const f = await fixture(t);
  const reviewer = { id: "single", name: "Single" };
  for (let i = 0; i < 3; i++)
    await f.jobs.register(f.changeSet, `group_${i}`, reviewer, undefined, {
      purpose: "review",
      files: [f.files[i].file],
      group: { index: i + 1, total: 3 },
    });
  assert.equal(f.jobs.list().length, 3);
  await f.answer("group_0", {
    files: { "src/a.ts": [{ heading: "A", review: "A" }] },
  });
  await f.answer("group_1", {
    files: {
      "src/b.ts": [{ heading: "B", review: "B" }],
      "src/c.ts": [{ heading: "injected", review: "wrong" }],
    },
  });
  await f.answer("group_2", {
    files: { "src/c.ts": [{ heading: "C", review: "C" }] },
  });
  const restarted = await new ReviewJobs(f.store, f.logs).init();
  assert.deepEqual(
    restarted.list().map((j) => j.status),
    ["completed", "failed", "completed"],
  );
  assert.equal((await f.store.get(f.files[0].id)).explanations[0].review, "A");
  assert.equal((await f.store.get(f.files[1].id)).explanations.length, 0);
  assert.equal((await f.store.get(f.files[2].id)).explanations[0].review, "C");
});
test("scopes, purpose and reviewer are independent dedup keys; overview ignores review-context changes", async (t) => {
  const f = await fixture(t);
  const a = await f.jobs.register(f.changeSet, "a", undefined, undefined, {
    purpose: "review",
    files: [f.files[0].file],
  });
  const duplicate = await f.jobs.register(
    f.changeSet,
    "duplicate",
    undefined,
    undefined,
    { purpose: "review", files: [f.files[0].file] },
  );
  assert.equal(a.sessionId, duplicate.sessionId);
  await f.jobs.register(f.changeSet, "summary", undefined, undefined, {
    purpose: "overview",
  });
  await f.store.setImportReviewContext({
    ...f.changeSet,
    reviewContext: "changed",
  });
  await f.answer("summary", { overview });
  await f.answer("a", {
    files: { "src/a.ts": [{ heading: "old", review: "old" }] },
  });
  await f.jobs.collect();
  assert.equal(f.jobs.list()[0].status, "failed");
  assert.equal(f.jobs.list()[1].status, "completed");
  assert.equal(
    (await f.store.get(f.files[0].id)).softwareOverview.summary,
    "目的",
  );
});

test("malformed scopes and invalid purpose never create a job", async (t) => {
  const f = await fixture(t);
  for (const options of [
    { purpose: "unknown" },
    { purpose: "review", files: [] },
    { purpose: "review", files: [f.files[0].file, f.files[0].file] },
    { purpose: "review", files: ["src/outside.ts"] },
    { purpose: "overview", files: [f.files[0].file] },
    {
      purpose: "review",
      files: [f.files[0].file],
      group: { index: 4, total: 3 },
    },
  ])
    await assert.rejects(
      f.jobs.register(f.changeSet, "invalid", undefined, undefined, options),
      { status: 400 },
    );
  assert.equal(f.jobs.list().length, 0);
});

test("review-only answers cannot overwrite overview; missing files fail atomically", async (t) => {
  const f = await fixture(t);
  await f.store.applyImportOverview(f.changeSet, overview);
  const saved = (await f.store.get(f.files[0].id)).softwareOverview;
  await f.jobs.register(f.changeSet, "review", undefined, undefined, {
    purpose: "review",
    files: [f.files[0].file],
  });
  await f.answer("review", {
    files: { "src/a.ts": [{ heading: "A", review: "A" }] },
    overview: { summary: "invalid" },
  });
  await f.jobs.collect();
  assert.equal(f.jobs.list()[0].status, "completed");
  assert.deepEqual((await f.store.get(f.files[0].id)).softwareOverview, saved);
  await f.jobs.register(f.changeSet, "missing", undefined, undefined, {
    purpose: "review",
    files: [f.files[0].file, f.files[1].file],
  });
  await f.answer("missing", {
    files: {
      "src/a.ts": [{ heading: "replace", review: "bad" }],
      "src/b.ts": [],
    },
  });
  await f.jobs.collect();
  assert.equal(f.jobs.list()[1].status, "failed");
  assert.equal((await f.store.get(f.files[0].id)).explanations[0].review, "A");
});

test("stale or invalid overview cannot replace a previous overview or review", async (t) => {
  const f = await fixture(t);
  await f.store.applyImportOverview(f.changeSet, overview);
  const saved = (await f.store.get(f.files[0].id)).softwareOverview;
  await f.jobs.register(f.changeSet, "invalid", undefined, undefined, {
    purpose: "overview",
  });
  await f.answer("invalid", { overview: { ...overview, nodes: [] } });
  await f.jobs.collect();
  assert.equal(f.jobs.list()[0].status, "failed");
  assert.deepEqual((await f.store.get(f.files[0].id)).softwareOverview, saved);
  await f.jobs.register(f.changeSet, "stale", undefined, undefined, {
    purpose: "overview",
  });
  for (const review of f.store.reviews)
    review.changeSet = { ...f.changeSet, revision: "base:other" };
  await f.answer("stale", { overview });
  await f.jobs.collect();
  assert.equal(f.jobs.list()[1].status, "failed");
  assert.deepEqual((await f.store.get(f.files[0].id)).softwareOverview, saved);
});
