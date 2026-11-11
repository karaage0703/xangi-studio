import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore, MAX_BYTES } from "../server/store.mjs";
import { createServer } from "../server/http.mjs";
import { reviewUrl, formatLink } from "../shared/links.mjs";
import {
  githubDescription,
  parseGitHubPullRequest,
  importGitHubPullRequest,
} from "../server/github-import.mjs";
import {
  buildAutoReviewPrompt,
  parseAutoReviewResponse,
  parseXangiChatEvents,
} from "../shared/auto-review.mjs";

test("PRのドットファイルを取り込み、通常ファイルの隠しパスは禁止する", async (t) => {
  const { store } = await fixture(t);
  const changeSet = {
    kind: "github-pr",
    id: "1",
    source: "owner/repo",
    revision: "base:head",
  };
  const review = await store.create({
    file: "changes/github/owner-repo/pr-1/base-head/.github/workflows/.env",
    content: "EXAMPLE=value\n",
    readOnly: true,
    changeSet,
  });
  assert.match((await store.get(review.id)).content, /EXAMPLE=value/);
  await assert.rejects(
    store.create({ file: "private/.env", content: "secret" }),
    /取り込めません/,
  );
  await assert.rejects(
    store.create({ file: "changes/github/../escape/.env", content: "secret" }),
    /取り込めません/,
  );
});

test("同じPR版でも不足したドットファイルを取り込み直す", async (t) => {
  const { store } = await fixture(t);
  const url = "https://github.com/owner/repo/pull/1";
  const base = "b".repeat(40);
  const head = "h".repeat(40);
  let includeDotfile = false;
  const github = {
    json: async (endpoint) =>
      endpoint.includes("/files?")
        ? ["README.md", ...(includeDotfile ? [".env"] : [])].map(
            (filename) => ({
              filename,
              status: "added",
              changes: 1,
              additions: 1,
              deletions: 0,
            }),
          )
        : {
            title: "PR",
            html_url: url,
            base: { sha: base },
            head: { sha: head },
            changed_files: 2,
          },
    raw: async (_owner, _repo, path) => `${path}=sample\n`,
  };
  const first = await importGitHubPullRequest(store, url, {}, github);
  assert.equal(first.imported.length, 1);
  includeDotfile = true;
  const second = await importGitHubPullRequest(store, url, {}, github);
  assert.equal(second.imported.length, 2);
  assert.ok(second.imported.some((item) => item.file.endsWith("/.env")));
  const saved = await store.save(first.imported[0].id, "edited README");
  await importGitHubPullRequest(
    store,
    url,
    { "README.md": [{ heading: "old upstream analysis" }] },
    github,
  );
  const reimported = await store.get(saved.id);
  assert.equal(reimported.content, "edited README");
  assert.equal(reimported.changeSet.editRevision, saved.changeSet.editRevision);
  assert.equal(reimported.explanations.length, 0);
});

test("AIレビュー結果を対象PRの現行版にだけ反映する", async (t) => {
  const { store } = await fixture(t);
  const changeSet = {
    kind: "github-pr",
    id: "7",
    title: "Update",
    source: "example/repo",
    url: "https://github.com/example/repo/pull/7",
    revision: `${"a".repeat(40)}:${"b".repeat(40)}`,
  };
  const imported = await store.create({
    file: `changes/github/example-repo/pr-7/aaaaaaaaaaaa-bbbbbbbbbbbb/src/change.ts`,
    before: "old\n",
    content: "new\n",
    readOnly: true,
    changeSet,
  });
  const analysis = {
    "src/change.ts": [
      {
        heading: "境界値",
        summary: "新しい処理",
        impact: "入力が変わる",
        review: "空文字のケースを確認する",
        severity: "warning",
        newStart: 1,
      },
    ],
  };
  await assert.rejects(
    store.applyImportAnalysis({ ...changeSet, revision: "stale" }, analysis),
    { status: 409 },
  );
  assert.deepEqual(await store.applyImportAnalysis(changeSet, analysis), {
    updated: 1,
    total: 1,
  });
  assert.equal(
    (await store.get(imported.id)).explanations[0].review,
    "空文字のケースを確認する",
  );
});

test("AIレビュー応答はJSONのファイル別結果だけを受け付ける", () => {
  const prompt = buildAutoReviewPrompt(
    "https://github.com/example/repo/pull/7",
    ["src/change.ts"],
  );
  assert.match(prompt, /src\/change\.ts/);
  assert.match(prompt, /秘密値そのものは結果に転載しない/);
  assert.deepEqual(
    parseAutoReviewResponse('```json\n{"files":{"src/change.ts":[]}}\n```'),
    { "src/change.ts": [] },
  );
  assert.throws(
    () => parseAutoReviewResponse("確認しました"),
    /有効なファイル別JSONがありません/,
  );
  assert.equal(
    parseXangiChatEvents(
      'event: text\ndata: {"fullText":"途中"}\n\nevent: done\ndata: {"response":"結果"}\n\n',
    ),
    "結果",
  );
  assert.throws(
    () => parseXangiChatEvents('event: error\ndata: {"message":"失敗"}\n\n'),
    /失敗/,
  );
});

test("レビュー反映APIは認証とPR版を検証する", async (t) => {
  const { dir, store } = await fixture(t);
  const dist = join(dir, "dist");
  await mkdir(dist);
  const server = createServer({ store, token: "test-access", distDir: dist });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const changeSet = {
    kind: "github-pr",
    id: "7",
    title: "Update",
    source: "example/repo",
    url: "https://github.com/example/repo/pull/7",
    revision: "a:b",
  };
  const review = await store.create({
    file: "changes/github/example-repo/pr-7/a-b/src/change.ts",
    before: "old\n",
    content: "new\n",
    readOnly: true,
    changeSet,
  });
  const body = JSON.stringify({
    changeSet,
    analysis: {
      "src/change.ts": [
        { heading: "確認", review: "問題なし", severity: "info" },
      ],
    },
  });
  const path = `${base}/api/import/github/analysis`;
  assert.equal(
    (
      await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
    ).status,
    401,
  );
  const response = await fetch(path, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-access",
      "Content-Type": "application/json",
    },
    body,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { updated: 1, total: 1 });
  assert.equal((await store.get(review.id)).explanations[0].review, "問題なし");
});

test("取り込み済みPRは版が同じなら取得を省き、更新時だけ旧版を一覧から隠す", async (t) => {
  const { store } = await fixture(t);
  const url = "https://github.com/example/repo/pull/7";
  let head = "a".repeat(40);
  let base = "b".repeat(40);
  let fileRequests = 0;
  const github = {
    json: (endpoint) => {
      if (endpoint.endsWith("/files?per_page=100")) {
        fileRequests++;
        return [
          {
            filename: "src/change.ts",
            status: "modified",
            changes: 1,
            additions: 1,
            deletions: 0,
            patch: "@@ -1 +1 @@",
          },
        ];
      }
      return {
        title: "Update",
        html_url: url,
        base: { sha: base },
        head: { sha: head },
      };
    },
    raw: (_owner, _repo, _path, ref) => (ref === head ? "after\n" : "before\n"),
  };
  const first = await importGitHubPullRequest(
    store,
    url,
    {},
    github,
    "  境界値と仕様抜粋を確認  ",
  );
  assert.equal(first.changeSet.reviewContext, "境界値と仕様抜粋を確認");
  assert.equal(first.status, "imported");
  assert.equal(fileRequests, 1);
  const unchanged = await importGitHubPullRequest(store, url, {}, github);
  assert.equal(unchanged.status, "unchanged");
  assert.equal(fileRequests, 1);
  assert.equal(store.list().length, 1);

  assert.equal(unchanged.changeSet.reviewContext, "境界値と仕様抜粋を確認");
  const contextChanged = await importGitHubPullRequest(
    store,
    url,
    {},
    github,
    "セキュリティ優先",
  );
  assert.equal(contextChanged.status, "updated");
  assert.equal(contextChanged.imported[0].id, first.imported[0].id);
  assert.equal(fileRequests, 1);
  await assert.rejects(
    store.applyImportAnalysis(first.changeSet, {
      "src/change.ts": [{ review: "古い指示の結果" }],
    }),
    { status: 409 },
  );
  assert.equal(store.list()[0].explanations.length, 0);
  head = "c".repeat(40);
  const updated = await importGitHubPullRequest(store, url, {}, github);
  assert.equal(updated.status, "updated");
  assert.equal(updated.changeSet.reviewContext, "セキュリティ優先");
  assert.equal(fileRequests, 2);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, updated.imported[0].id);
  assert.equal((await store.get(first.imported[0].id)).content, "after\n");

  base = "d".repeat(40);
  const rebased = await importGitHubPullRequest(store, url, {}, github);
  assert.equal(rebased.status, "updated");
  assert.equal(fileRequests, 3);
  assert.notEqual(rebased.imported[0].id, updated.imported[0].id);
  assert.equal(store.list().length, 1);
});

test("旧形式の取り込み済みPRもHEAD一致ならファイルを再取得しない", async (t) => {
  const { store } = await fixture(t);
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const url = "https://github.com/example/repo/pull/7";
  await store.create({
    file: `changes/github/example-repo/pr-7/${head.slice(0, 12)}/src/change.ts`,
    content: "after\n",
    before: "before\n",
    readOnly: true,
    changeSet: {
      kind: "github-pr",
      id: "7",
      title: "Old",
      url,
      source: "example/repo",
    },
  });
  const result = await importGitHubPullRequest(
    store,
    url,
    {},
    {
      json: () => ({
        title: "Old",
        html_url: url,
        base: { sha: base },
        head: { sha: head },
      }),
      raw: () => {
        throw new Error("File fetch must be skipped");
      },
    },
  );
  assert.equal(result.status, "unchanged");
  assert.equal(store.list()[0].changeSet.revision, `${base}:${head}`);
});

test("GitHub PR URLだけを受け付ける", () => {
  assert.deepEqual(
    parseGitHubPullRequest("https://github.com/example/repo/pull/42"),
    { owner: "example", repo: "repo", number: 42 },
  );
  assert.throws(
    () => parseGitHubPullRequest("https://example.com/repo/pull/42"),
    (error) => error.status === 400,
  );
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "xangi-editor-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "workspace");
  const state = join(dir, "state");
  const store = await new ReviewStore(root, state).init();
  await writeFile(join(root, "sample.md"), "# 原稿\n最初の一文。\n");
  return { dir, root, state, store };
}

test("AI作業前の内容を保持し、保存内容と履歴を再起動後も読める", async (t) => {
  const { root, state, store } = await fixture(t);
  const begun = await store.create({ file: "sample.md", source: "slack" });
  await writeFile(join(root, "sample.md"), "# 原稿\nAIの変更。\n");
  const current = await store.get(begun.id);
  const saved = await store.save(
    begun.id,
    "# 原稿\n手で修正。\n",
    current.version,
  );
  assert.equal(saved.before, begun.content);
  assert.equal(await readFile(join(root, "sample.md"), "utf8"), saved.content);
  assert.equal(
    store.snapshot(begun.id, saved.history.at(-1).id).content,
    current.content,
  );
  const reopened = await new ReviewStore(root, state).init();
  assert.deepEqual(await reopened.get(begun.id), saved);
});

test("外部更新後も版指定なしで保存し、保存前の本文は履歴に残す", async (t) => {
  const { root, store } = await fixture(t);
  const initial = await store.create({ file: "sample.md" });
  await writeFile(join(root, "sample.md"), "別の場所で更新\n");
  const saved = await store.save(initial.id, "保存した本文");
  assert.equal(await readFile(join(root, "sample.md"), "utf8"), "保存した本文");
  assert.equal(
    store.snapshot(initial.id, saved.history.at(-1).id).content,
    "別の場所で更新\n",
  );
});
test("同時保存は順番に成功し最後の本文を採用する", async (t) => {
  const { store } = await fixture(t);
  const initial = await store.create({ file: "sample.md" });
  const results = await Promise.all([
    store.save(initial.id, "A"),
    store.save(initial.id, "B"),
  ]);
  assert.equal(results.length, 2);
  const saved = await store.get(initial.id);
  assert.equal(saved.content, "B");
  assert.equal(
    store.snapshot(initial.id, saved.history.at(-1).id).content,
    "A",
  );
});

test("範囲外パス・ドットファイル・シンボリックリンクを拒否する", async (t) => {
  const { root, dir, store } = await fixture(t);
  await writeFile(join(dir, "outside.md"), "private");
  await symlink(join(dir, "outside.md"), join(root, "link.md"));
  await writeFile(join(root, ".env"), "secret");
  for (const file of [
    "../outside.md",
    join(dir, "outside.md"),
    ".env",
    "link.md",
    "folder\\sample.md",
  ]) {
    await assert.rejects(store.create({ file }), (e) =>
      [400, 403].includes(e.status),
    );
  }
});

test("非UTF-8とサイズ超過を拒否する", async (t) => {
  const { root, store } = await fixture(t);
  await writeFile(join(root, "bad.txt"), Buffer.from([0xff, 0xfe]));
  await writeFile(join(root, "large.txt"), "x".repeat(MAX_BYTES + 1));
  await assert.rejects(store.read("bad.txt"), { status: 415 });
  await assert.rejects(store.read("large.txt"), { status: 413 });
});

test("保存時に既存のCRLFを維持する", async (t) => {
  const { root, store } = await fixture(t);
  await writeFile(join(root, "sample.md"), "a\r\nb\r\n");
  const initial = await store.create({ file: "sample.md" });
  const saved = await store.save(initial.id, "a\nc\n", initial.version);
  assert.equal(saved.content, "a\r\nc\r\n");
});

test("PRの内容と説明を取り込み、Studioのコピーを編集できる", async (t) => {
  const { root, store } = await fixture(t);
  const review = await store.create({
    file: "pulls/example/repo/pr-7/src/change.ts",
    title: "入力検証を追加",
    before: "export const value = input;\n",
    content: "export const value = input.trim();\n",
    readOnly: true,
    changeSet: {
      kind: "github-pr",
      id: "7",
      title: "入力検証を追加",
      url: "https://github.com/example/repo/pull/7",
      source: "example/repo",
    },
    explanations: [
      {
        heading: "空白を除去",
        summary: "入力値の前後にある空白を取り除きます。",
        impact: "保存される値が正規化されます。",
        review: "空文字になる入力の扱いを確認してください。",
        severity: "warning",
        oldStart: 1,
        newStart: 1,
      },
    ],
  });
  assert.equal(
    await readFile(join(root, review.file), "utf8"),
    "export const value = input.trim();\n",
  );
  assert.equal(review.explanations[0].heading, "空白を除去");
  assert.equal(review.explanations[0].severity, "warning");
  assert.match(review.explanations[0].review, /空文字/);
  assert.equal(review.readOnly, false);
  assert.equal((await store.save(review.id, "変更")).content, "変更");
});

test("JSONL fixtureをレビュー対象として保存できる", async (t) => {
  const { root, store } = await fixture(t);
  const review = await store.create({
    file: "changes/github/example-repo/pr-8/tests/fixtures/resume.jsonl",
    before: '{"type":"start"}\n',
    content: '{"type":"start"}\n{"type":"stop"}\n',
    readOnly: true,
    explanations: [
      {
        heading: "中断イベントを追加",
        summary: "再開テスト用の実測イベントを追加します。",
        impact: "fixtureの再現条件が変わります。",
        review: "実データの秘密情報が含まれていないことを確認してください。",
        severity: "warning",
        oldStart: 1,
        newStart: 2,
      },
    ],
  });
  assert.match(await readFile(join(root, review.file), "utf8"), /stop/);
  assert.equal(review.explanations[0].severity, "warning");
});

test("PRのスクリプトと拡張子のないテキストを取り込める", async (t) => {
  const { store } = await fixture(t);
  for (const [file, content] of [
    ["server/import.mjs", "export const value = 1;\n"],
    ["scripts/setup.sh", "#!/bin/sh\n"],
    ["LICENSE", "MIT License\n"],
    [".gitignore", "node_modules/\n"],
    ["scripts/prepare-update", "#!/bin/sh\n"],
  ]) {
    const review = await store.create({
      file: `changes/github/example-repo/pr-8/${file}`,
      before: "",
      content,
      readOnly: true,
    });
    assert.equal((await store.get(review.id)).content, content);
  }
});

test("同じPR HEADの再取込では既存レビューの説明を更新する", async (t) => {
  const { root, state, store } = await fixture(t);
  const file = "changes/github/example-repo/pr-7/abc123/src/change.ts";
  const first = await store.create({
    file,
    before: "before\n",
    content: "after\n",
    readOnly: true,
    changeSet: {
      kind: "github-pr",
      id: "7",
      title: "最初の説明",
      url: "https://github.com/example/repo/pull/7",
      source: "example/repo",
    },
    explanations: [],
  });
  const updated = await store.updateImported(file, {
    title: "詳しい説明",
    sourceUrl: "https://github.com/example/repo/pull/7",
    changeSet: first.changeSet,
    explanations: [{ heading: "更新", summary: "説明", impact: "影響" }],
  });
  assert.equal(updated.id, first.id);
  assert.equal(updated.title, "詳しい説明");
  assert.equal(updated.explanations[0].heading, "更新");
  assert.equal(store.list().length, 1);

  await store.create({
    file,
    before: "before\n",
    content: "after\n",
    readOnly: true,
    changeSet: first.changeSet,
  });
  assert.equal(store.list().length, 2);
  const reopened = await new ReviewStore(root, state).init();
  assert.equal(reopened.list().length, 1);
});

test("レビュー設定とPRのアーカイブ状態を端末間で共有できる", async (t) => {
  const { root, state, store } = await fixture(t);
  const changeSet = {
    kind: "github-pr",
    id: "42",
    title: "設定画面を追加",
    url: "https://github.com/example/repo/pull/42",
    source: "example/repo",
  };
  await store.create({
    file: "pulls/example/repo/pr-42/change.ts",
    content: "export const changed = true;\n",
    before: "export const changed = false;\n",
    readOnly: true,
    changeSet,
  });
  await store.updateReviewPreferences({
    defaultProjectId: "project-default",
    reviewerProjectIds: ["project-extra", "project-default"],
  });
  await store.setChangeSetArchived("github-pr:example/repo:42", true);
  assert.equal(store.list().length, 0);
  assert.equal(
    store.reviewPreferences().archivedChangeSets[0].title,
    changeSet.title,
  );

  const reopened = await new ReviewStore(root, state).init();
  assert.equal(
    reopened.reviewPreferences().defaultProjectId,
    "project-default",
  );
  assert.deepEqual(reopened.reviewPreferences().reviewerProjectIds, [
    "project-extra",
  ]);
  assert.equal(reopened.list().length, 0);
  await reopened.setChangeSetArchived("github-pr:example/repo:42", false);
  assert.equal(reopened.list().length, 1);
});

test("レビュワー未指定ならxangiのデフォルト設定を保持する", async (t) => {
  const { root, state, store } = await fixture(t);
  await store.updateReviewPreferences({
    defaultProjectId: null,
    reviewerProjectIds: ["project-extra"],
  });
  assert.equal(store.reviewPreferences().defaultProjectId, null);
  assert.deepEqual(store.reviewPreferences().reviewerProjectIds, [
    "project-extra",
  ]);
  const reopened = await new ReviewStore(root, state).init();
  assert.equal(reopened.reviewPreferences().defaultProjectId, null);
});

test("HTTP APIは認証・入力検証・保存競合を実施する", async (t) => {
  const { dir, root, store } = await fixture(t);
  const dist = join(dir, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "<h1>test</h1>");
  const server = createServer({ store, token: "test-access", distDir: dist });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/reviews`)).status, 401);
  assert.equal((await fetch(`${url}/api/reviews?key=test-access`)).status, 401);
  const headers = {
    Authorization: "Bearer test-access",
    "Content-Type": "application/json",
  };
  const created = await fetch(`${url}/api/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      file: "sample.md",
      source: "discord",
      id: "chosen-id",
    }),
  });
  assert.equal(created.status, 201);
  const review = await created.json();
  assert.notEqual(review.id, "chosen-id");
  await writeFile(join(root, "sample.md"), "最新の内容");
  const conflict = await fetch(`${url}/api/reviews/${review.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ content: "保存した内容" }),
  });
  assert.equal(conflict.status, 200);
  assert.equal((await conflict.json()).content, "保存した内容");
  const savedDraft = await fetch(`${url}/api/drafts/review/${review.id}`, {
    headers,
  });
  assert.equal((await savedDraft.json()).content, "保存した内容");
  const bad = await fetch(`${url}/api/reviews`, {
    method: "POST",
    headers,
    body: "{",
  });
  assert.equal(bad.status, 400);
  for (const invalid of ["null", "[]", '"text"']) {
    const response = await fetch(`${url}/api/reviews`, {
      method: "POST",
      headers,
      body: invalid,
    });
    assert.equal(response.status, 400);
  }
  const cross = await fetch(`${url}/api/reviews`, {
    headers: { ...headers, "sec-fetch-site": "cross-site" },
  });
  assert.equal(cross.status, 403);
  const defaultReviewer = await fetch(`${url}/api/preferences`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ defaultProjectId: null, reviewerProjectIds: [] }),
  });
  assert.equal(defaultReviewer.status, 200);
  assert.equal((await defaultReviewer.json()).defaultProjectId, null);
  const preferences = await fetch(`${url}/api/preferences`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      defaultProjectId: "project-default",
      reviewerProjectIds: ["project-extra"],
    }),
  });
  assert.equal(preferences.status, 200);
  assert.equal((await preferences.json()).defaultProjectId, "project-default");
});

test("PR取り込み中もAPIが応答し、完了後に結果を取得できる", async (t) => {
  const { dir, store } = await fixture(t);
  const dist = join(dir, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "<h1>test</h1>");
  let finishImport;
  let calls = 0;
  const server = createServer({
    store,
    token: "test-access",
    distDir: dist,
    importPullRequest: () => {
      calls++;
      return new Promise((resolve) => {
        finishImport = resolve;
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    Authorization: "Bearer test-access",
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({
    url: "https://github.com/example/repo/pull/7",
  });
  const started = await fetch(`${base}/api/import/github`, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(started.status, 202);
  const { id } = await started.json();
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const jobUrl = `${base}/api/import/github/jobs/${id}`;
  assert.equal((await fetch(jobUrl)).status, 401);
  assert.equal(
    (await (await fetch(jobUrl, { headers })).json()).status,
    "running",
  );
  const duplicate = await fetch(`${base}/import/github`, {
    method: "POST",
    headers,
    body,
  });
  assert.equal((await duplicate.json()).id, id);
  assert.equal(calls, 1);
  finishImport({
    status: "imported",
    imported: [{ id: "review-1", content: "large content" }],
    skipped: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const finished = await (await fetch(jobUrl, { headers })).json();
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.result.imported, [{ id: "review-1" }]);
});

test("Discord・Slack・Webのリンクは同じレビューを開く", () => {
  const url = reviewUrl(
    "http://localhost:18930",
    "sample-id",
    "key-value",
    "diff",
  );
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/review/sample-id");
  assert.equal(parsed.searchParams.get("mode"), "diff");
  assert.equal(
    new URLSearchParams(parsed.hash.slice(1)).get("key"),
    "key-value",
  );
  assert.equal(formatLink(url, "日本語.md", "discord"), `[日本語.md](${url})`);
  assert.equal(
    formatLink(url, "a|b<>&", "slack"),
    `<${url}|a｜b&lt;&gt;&amp;>`,
  );
  assert.equal(formatLink(url, "日本語.md", "web"), url);
});

test("GitHub PR URLだけを入力として受け付ける", () => {
  assert.deepEqual(
    parseGitHubPullRequest("https://github.com/example/repo/pull/123"),
    { owner: "example", repo: "repo", number: 123 },
  );
  assert.throws(() => parseGitHubPullRequest("https://example.com/pull/123"));
  assert.throws(() =>
    parseGitHubPullRequest("https://github.com/example/repo"),
  );
});

test("PR description preserves GitHub Markdown and handles an empty body", async () => {
  const body = "## 目的\n\n- [x] 課題を修正\n\n```ts\nconst n = 1\n```";
  const url = "https://github.com/example/repo/pull/7";
  const result = await githubDescription(url, {
    json: async (path) => {
      assert.equal(path, "repos/example/repo/pulls/7");
      return { title: "Purpose", body, html_url: url };
    },
  });
  assert.equal(result.body, body);
  assert.equal(result.title, "Purpose");
  assert.equal(
    (await githubDescription(url, { json: async () => ({ body: null }) })).body,
    "",
  );
  await assert.rejects(
    githubDescription("http://untrusted.test", {
      json: () => {
        throw new Error("must not fetch");
      },
    }),
    { status: 400 },
  );
});

test("レビューJSONの後続ノイズと単独項目を復元し、不完全・曖昧な結果は拒否する", () => {
  const entry = {
    heading: "引用 } {",
    review: '確認した "値" と \\ を含む',
    severity: "info",
  };
  const result = JSON.stringify({ files: { "src/change.ts": entry } });
  assert.deepEqual(
    parseAutoReviewResponse(result + '\n{"to":"..","newStart":819}}'),
    { "src/change.ts": [entry] },
  );
  assert.deepEqual(
    parseAutoReviewResponse("説明\n```json\n" + result + "\n```"),
    { "src/change.ts": [entry] },
  );
  assert.throws(
    () => parseAutoReviewResponse('{"files":{"a":[{"review":"途中'),
    /途中で途切れ/,
  );
  assert.throws(
    () => parseAutoReviewResponse(result + result),
    /複数のレビュー/,
  );
  assert.throws(
    () => parseAutoReviewResponse('{"files":[]}'),
    /有効なファイル別JSON/,
  );
});

test("ホーム一覧は本文を除き、認証後に本文の識別子で変更を確認する", async (t) => {
  const { dir, store } = await fixture(t);
  await store.create({
    file: "sample.md",
    content: "large content".repeat(1000),
  });
  const server = createServer({ store, token: "test", distDir: dir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/api/reviews?summary=home", "/api/preferences"]) {
    const headers = { Authorization: "Bearer test" };
    const response = await fetch(
      base + path + (path.includes("?") ? "&" : "?") + "poll=1",
      { headers },
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.doesNotMatch(
      body,
      /large content|private long prompt|versions|history|explanations/,
    );
    const revision = JSON.parse(body).revision;
    assert.ok(revision);
    const pollUrl =
      base +
      path +
      (path.includes("?") ? "&" : "?") +
      "poll=1&since=" +
      revision;
    const unchanged = await fetch(pollUrl, { headers });
    assert.equal(unchanged.status, 200);
    assert.deepEqual(await unchanged.json(), { revision, unchanged: true });
    assert.equal((await fetch(pollUrl)).status, 401);
    if (path.includes("reviews")) {
      await store.create({ file: "new.md", content: "new" });
      const changed = await fetch(pollUrl, { headers });
      const payload = await changed.json();
      assert.notEqual(payload.revision, revision);
      assert.equal(payload.data.length, 2);
    }
  }
});
