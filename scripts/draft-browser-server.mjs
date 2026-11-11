// Isolated draft/real editor fixture. No external APIs, agents or source repos.
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ReviewStore } from "../server/store.mjs";
import { createServer } from "../server/http.mjs";
const root = await mkdtemp(join(tmpdir(), "studio-draft-browser-"));
const store = await new ReviewStore(
  join(root, "files"),
  join(root, "state"),
).init();
const original = Array.from(
  { length: 600 },
  (_, i) => `行${i + 1} 編集と保存の確認用の文章です。`,
).join("\n");
const review = await store.create({ file: "draft.md", content: original });
const service = createServer({
  store,
  token: "test",
  distDir: resolve("dist"),
});
await new Promise((r) => service.listen(0, "127.0.0.1", r));
let sourceFail = false;
let fail = false,
  delay = 0;
const writes = [];
const proxy = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, "http://localhost");
    if (parsed.pathname === "/control") {
      let b = "";
      for await (const c of req) b += c;
      const data = JSON.parse(b || "{}");
      if (data.external) {
        const current = await store.get(review.id);
        await store.save(review.id, "外部から更新された本文", current.version);
      }
      sourceFail = data.sourceFail ?? false;
      fail = data.fail ?? false;
      delay = data.delay ?? 0;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
      return;
    }
    if (parsed.pathname === "/stats") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          review: await store.get(review.id),
          writes,
        }),
      );
      return;
    }
    if (
      [
        "/api/projects",
        "/api/agents",
        "/api/workspaces",
        "/api/review-jobs",
      ].includes(parsed.pathname)
    ) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        parsed.pathname === "/api/review-jobs"
          ? "[]"
          : JSON.stringify({ projects: [], agents: [], workspaces: [] }),
      );
      return;
    }
    const ui = parsed.pathname.endsWith("/ui");
    const path = ui
      ? "/ui"
      : parsed.pathname.replace("/api/extensions/xangi-studio/service", "");
    let body = "";
    for await (const c of req) body += c;
    if (path.startsWith("/api/drafts/") && req.method === "PUT") {
      writes.push(JSON.parse(body));
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (fail) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "保存先に接続できません。本文は残しています。",
          }),
        );
        return;
      }
    }
    if (
      sourceFail &&
      path.startsWith("/api/reviews/") &&
      req.method === "PUT"
    ) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ファイル保存に失敗しました" }));
      return;
    }
    const upstream = await fetch(
      `http://127.0.0.1:${service.address().port}${path}${parsed.search}`,
      {
        method: req.method,
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      },
    );
    let bytes = Buffer.from(await upstream.arrayBuffer());
    if (ui)
      bytes = Buffer.from(
        bytes.toString().replace("<head>", '<head><base href="./service/">'),
      );
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type"),
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'",
    });
    res.end(bytes);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
console.log(
  JSON.stringify({
    port: proxy.address().port,
    reviewId: review.id,
  }),
);
process.on("SIGTERM", async () => {
  proxy.closeAllConnections();
  service.closeAllConnections();
  proxy.close();
  service.close();
  await rm(root, { recursive: true, force: true });
  process.exit();
});
