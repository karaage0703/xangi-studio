import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const repo = process.argv[2];
const { ReviewStore } = await import(`${repo}/server/store.mjs`);
const { ReviewJobs } = await import(`${repo}/server/review-jobs.mjs`);
const { sourcePath } = await import(`${repo}/shared/software-overview.mjs`);
const { NotionExport } = await import(`${repo}/server/notion.mjs`);
const { createServer } = await import(`${repo}/server/http.mjs`);
const { samplePdf } = await import(`${repo}/tests/helpers/pdf.mjs`);
const root = await mkdtemp(join(tmpdir(), "pdf-browser-"));
const logs = join(root, "logs");
await mkdir(logs);
// More than 1MB with binary bytes ensures chunking is exercised by the browser.
await writeFile(
  join(root, "sample.pdf"),
  Buffer.concat([samplePdf(), Buffer.alloc(1200000, 255)]),
);
const store = await new ReviewStore(
  join(root, "files"),
  join(root, "state"),
).init();
const jobs = await new ReviewJobs(store, logs).init();
jobs.start();
let chats = 0;
const prompts = [];
const chatStarts = [],
  chatFinishes = [];
let pipelineFailed = false;
let notionCalls = 0;
const notion = new NotionExport(store, {
  token: "test",
  parent: "a".repeat(32),
  fetcher: async (url) => {
    if (url.endsWith("/file_uploads"))
      return Response.json({ id: "upload-test" });
    if (url.endsWith("/send")) return Response.json({ status: "uploaded" });
    notionCalls++;
    return Response.json({ id: "test", url: "https://www.notion.so/test" });
  },
});
const { Documents } = await import(`${repo}/server/documents.mjs`);
await store.updateReviewPreferences({
  defaultProjectId: null,
  reviewerProjectIds: ["reviewer-b"],
});
const documents = new Documents(store, {
  googleExporter: async (url) => ({
    bytes: samplePdf(),
    title: url.includes("presentation")
      ? "Google Slides sample"
      : "Google Docs sample",
    sourceUrl: url,
    source: url.includes("presentation") ? "Google Slides" : "Google Docs",
  }),
});
const server = createServer({
  documents,
  importRepository: async (store, url, analysis, _github, reviewContext) => {
    const { importGitHubRepository } = await import(
      `${repo}/server/github-repository.mjs`
    );
    return importGitHubRepository(
      store,
      url,
      analysis,
      {
        json: async (path) => {
          if (path.includes("/commits/")) return { sha: "a".repeat(40) };
          if (path.includes("/trees/"))
            return {
              tree: [
                ...(process.env.REPOSITORY_READER_FIXTURE
                  ? [
                      {
                        path: "README.md",
                        type: "blob",
                        mode: "100644",
                        size: 100,
                        sha: "readme",
                      },
                      {
                        path: "empty.txt",
                        type: "blob",
                        mode: "100644",
                        size: 0,
                        sha: "empty",
                      },
                    ]
                  : []),
                {
                  path: "src/example.ts",
                  type: "blob",
                  mode: "100644",
                  size: 20,
                  sha: "blob",
                },
                ...(process.env.REVIEW_PIPELINE_FIXTURE
                  ? ["b", "c", "d", "e", "f"].map((name) => ({
                      path: `src/${name}.ts`,
                      type: "blob",
                      mode: "100644",
                      size: 20,
                      sha: "blob",
                    }))
                  : []),
              ],
            };
          if (path.includes("/blobs/"))
            return {
              encoding: "base64",
              content: Buffer.from(
                path.endsWith("/readme")
                  ? "# Project guide\n\nRead the overview, then choose a file.\n\n- First step\n- Second step\n"
                  : path.endsWith("/empty")
                    ? ""
                    : "export const n=2;\n",
              ).toString("base64"),
            };
          return { default_branch: "main" };
        },
      },
      reviewContext,
    );
  },
  importPullRequest: async (store, url, analysis, github, reviewContext) => {
    const changeSet = {
      kind: "github-pr",
      id: "1",
      source: "example/repo",
      title: "Example PR",
      url,
      revision: "a:b",
      reviewContext,
    };
    const existing = store.list().filter((r) => r.changeSet?.url === url);
    if (existing.length)
      return { status: "unchanged", imported: [], skipped: [] };
    const item = await store.create({
      file: "changes/github/example-repo/pr-1/a-b/src/example.ts",
      title: "PR file",
      content: "export const n=2;",
      before: "export const n=1;",
      readOnly: true,
      changeSet,
    });
    const extras = [];
    if (process.env.REVIEW_PIPELINE_FIXTURE)
      for (const name of ["b", "c", "d", "e", "f"])
        extras.push(
          await store.create({
            file: `changes/github/example-repo/pr-1/a-b/src/${name}.ts`,
            title: name,
            content: "export const n=2;",
            before: "export const n=1;",
            readOnly: true,
            changeSet,
          }),
        );
    return { status: "imported", imported: [item, ...extras], skipped: [] };
  },
  store,
  reviewJobs: jobs,
  notion,
  token: "test",
  distDir: resolve(repo, "dist"),
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const proxy = http.createServer(async (req, res) => {
  try {
    if (req.url.endsWith("/github-description")) {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          title: "Example PR",
          body: "Mocked description",
          url: "https://github.com/example/repo/pull/1",
        }),
      );
    }
    if (req.url === "/stats") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          chats,
          prompts,
          chatStarts,
          chatFinishes,
          notionCalls,
          jobs: jobs.list(),
          reviews: store.list(),
        }),
      );
    }
    if (req.url === "/api/agents")
      return res.end(
        JSON.stringify({
          agents: [{ id: "reviewer-b", name: "Reviewer B" }],
        }),
      );
    if (req.url === "/api/sessions")
      return res.end(JSON.stringify({ sessionId: `ui_${++chats}` }));
    if (req.url === "/api/chat") {
      let body = "";
      for await (const c of req) body += c;
      const { appSessionId, message } = JSON.parse(body);
      prompts.push(message);
      chatStarts.push({ sessionId: appSessionId, at: Date.now() });
      const fail =
        process.env.REVIEW_PIPELINE_FAIL_ONCE &&
        !pipelineFailed &&
        !message.includes("これは概要の作成です") &&
        message.includes('"src/f.ts"');
      if (fail) pipelineFailed = true;
      await writeFile(
        join(logs, `${appSessionId}.jsonl`),
        JSON.stringify({ role: "user", content: message }) + "\n",
      );
      setTimeout(async () => {
        const files = Object.fromEntries(
          store
            .list()
            .filter(
              (r) =>
                message.includes(r.changeSet.url) &&
                (r.document ||
                  message.includes(JSON.stringify(sourcePath(r.file)))),
            )
            .map((r) => [
              r.document ? r.file : sourcePath(r.file),
              [
                ...(r.document?.page === 1
                  ? [
                      {
                        heading: "資料全体の概要",
                        summary:
                          "初心者向けに生成AIの活用方法と具体例を紹介する資料です。",
                        severity: "info",
                        review: "",
                      },
                    ]
                  : []),
                {
                  heading: `${r.document?.page ?? 1}ページの確認`,
                  summary: "ページ内容",
                  review:
                    `確認済みページ${r.document?.page ?? 1}。` +
                    "長い指摘も末尾まで読めます。".repeat(20),
                  severity: "warning",
                },
              ],
            ]),
        );
        await writeFile(
          join(logs, `${appSessionId}.jsonl`),
          [
            JSON.stringify({ role: "user", content: message }),
            JSON.stringify({
              role: "assistant",
              content: {
                result: fail
                  ? "simulated malformed answer"
                  : JSON.stringify({
                      ...(message.includes("これは概要の作成です")
                        ? {}
                        : { files }),
                      ...(process.env.SOFTWARE_OVERVIEW_FIXTURE &&
                      message.includes("overview")
                        ? {
                            overview: {
                              summary:
                                '利用者の入力を検証し、設定を保存するソフトです。<img src=x onerror="window.overviewInjected=1">',
                              before: "入力値をそのまま保存していた。",
                              after: "不正な入力を拒否して保存する。",
                              nodes: [
                                {
                                  id: "input",
                                  label: "入力",
                                  description: "利用者の入力を検証する。",
                                  files: ["src/example.ts"],
                                },
                                {
                                  id: "store",
                                  label: "保存",
                                  description: "検証済みの値を保持する。",
                                  files: ["src/example.ts"],
                                },
                              ],
                              edges: [
                                {
                                  from: "input",
                                  to: "store",
                                  label: "検証済みの値を渡す",
                                },
                              ],
                              decisions: [
                                {
                                  fact: "空の値を拒否する",
                                  reason: "空の設定を防ぐため",
                                  question: "空値を許可しない仕様でよいか",
                                  files: ["src/example.ts"],
                                },
                              ],
                              limitations: ["テスト未実行。外部連携は未確認。"],
                            },
                          }
                        : {}),
                    }),
              },
            }),
          ].join("\n"),
        );
        chatFinishes.push({ sessionId: appSessionId, at: Date.now() });
      }, 2500);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(
        'event: done\ndata: {"response":"collected by server"}\n\n',
      );
    }
    const ui = req.url.startsWith("/api/extensions/xangi-studio/ui");
    const path = ui
      ? "/ui"
      : req.url.replace("/api/extensions/xangi-studio/service", "");
    let body = "";
    for await (const c of req) body += c;
    if (Buffer.byteLength(body) > 1024 * 1024) {
      res.statusCode = 413;
      return res.end("{}");
    }
    const upstream = await fetch(base + path, {
      method: req.method,
      headers: {
        Authorization: "Bearer test",
        "Content-Type": req.headers["content-type"] ?? "application/json",
      },
      body: req.method === "GET" ? undefined : body,
    });
    let bytes = Buffer.from(await upstream.arrayBuffer());
    if (ui)
      bytes = Buffer.from(
        bytes.toString().replace("<head>", '<head><base href="./service/">'),
      );
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type"),
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
    });
    res.end(bytes);
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
console.log(JSON.stringify({ port: proxy.address().port, root }));
process.on("SIGTERM", async () => {
  jobs.stop();
  proxy.closeAllConnections();
  server.closeAllConnections();
  proxy.close();
  server.close();
  await rm(root, { recursive: true, force: true });
  process.exit();
});
