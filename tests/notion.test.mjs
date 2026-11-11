import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../server/store.mjs";
import {
  NotionExport,
  notionPayload,
  existingNotionToken,
  savedNotionParent,
} from "../server/notion.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "review-notion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  const review = await store.create({
    file: "sample.md",
    content: "private original",
    explanations: [
      {
        heading: "確認",
        review: "long review ".repeat(200),
        severity: "warning",
      },
    ],
  });
  return { store, review, config: { token: "fake", parent: "a".repeat(32) } };
}
test("optional Notion export sends reviews with source and deduplicates double click and restart", async (t) => {
  const { store, review, config } = await fixture(t);
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.notion.com/v1/pages");
    assert.equal(options.headers.Authorization, "Bearer fake");
    assert.equal(options.body.includes("private original"), true);
    return Response.json({
      id: "page-id",
      url: "https://www.notion.so/page-id",
    });
  };
  const exporter = new NotionExport(store, { ...config, fetcher });
  const [a, b] = await Promise.all([
    exporter.save(review.id),
    exporter.save(review.id),
  ]);
  assert.equal(a.url, b.url);
  assert.equal(calls, 1);
  assert.equal(
    (await new NotionExport(store, { ...config, fetcher }).save(review.id)).url,
    a.url,
  );
  assert.equal(calls, 1);
});
test("disabled, rejection and ambiguous write have actionable errors without unsafe retries", async (t) => {
  const { store, review, config } = await fixture(t);
  await assert.rejects(
    new NotionExport(store, { token: "", parent: "" }).save(review.id),
    { status: 503 },
  );
  const denied = new NotionExport(store, {
    ...config,
    fetcher: async () => new Response("{}", { status: 403 }),
  });
  await assert.rejects(denied.save(review.id), /HTTP 403/);
  let calls = 0;
  const uncertain = new NotionExport(store, {
    ...config,
    fetcher: async () => {
      calls++;
      throw new Error("timeout");
    },
  });
  await assert.rejects(uncertain.save(review.id), /通信が中断/);
  await assert.rejects(uncertain.save(review.id), { status: 409 });
  assert.equal(calls, 1);
});
test("Notion payload splits long text and rejects oversize before sending", () => {
  const r = {
    title: "test",
    file: "test.md",
    explanations: [{ review: "a".repeat(5000) }],
  };
  const payload = notionPayload([r], "parent");
  const blocks = payload.children.filter((b) => b.type === "paragraph");
  assert.ok(
    blocks.every((b) =>
      b.paragraph.rich_text.every((x) => x.text.content.length <= 2000),
    ),
  );
  assert.ok(notionPayload(Array(100).fill(r), "parent").children.length > 100);
});

test("existing Notion credentials and optional override", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "notion-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(existingNotionToken({ env: {}, home }), "");
  await mkdir(join(home, ".config/notion"), { recursive: true });
  await writeFile(join(home, ".config/notion/api_key"), "host-token\n", {
    mode: 0o600,
  });
  assert.equal(existingNotionToken({ env: {}, home }), "host-token");
  assert.equal(
    existingNotionToken({ env: { XANGI_REVIEW_NOTION_TOKEN: "" }, home }),
    "host-token",
  );
  assert.equal(
    existingNotionToken({
      env: { XANGI_REVIEW_NOTION_TOKEN: "override" },
      home,
    }),
    "override",
  );
});

test("Notion destination persists separately from credentials", async (t) => {
  const { store } = await fixture(t);
  assert.equal(savedNotionParent(store.stateDir), undefined);
  await writeFile(
    join(store.stateDir, "notion-settings.json"),
    JSON.stringify({ parentPageId: "a".repeat(32) }),
  );
  assert.equal(savedNotionParent(store.stateDir), "a".repeat(32));
  assert.equal(new NotionExport(store, { token: "test" }).configured(), true);
});

test("Notion app.notion.com URLs are persisted and reused without another POST", async (t) => {
  const { store, review, config } = await fixture(t);
  let calls = 0;
  const url = "https://app.notion.com/p/review-123";
  const fetcher = async () => {
    calls++;
    return Response.json({ id: "page-id", url });
  };
  assert.equal(
    (await new NotionExport(store, { ...config, fetcher }).save(review.id)).url,
    url,
  );
  assert.equal(
    (await new NotionExport(store, { ...config, fetcher }).save(review.id)).url,
    url,
  );
  assert.equal(calls, 1);
});

test("100 document pages upload images, batch blocks, and retain deduplication", async (t) => {
  const { store, config } = await fixture(t);
  const reviews = Array.from({ length: 100 }, (_, i) => ({
    id: `review-${i}`,
    file: `page-${i}.txt`,
    content: `text ${i}`,
    title: "Readable title",
    document: { id: "doc", name: "Readable title", page: i + 1 },
    changeSet: {
      kind: "artifact",
      id: "doc",
      title: "Readable title",
      revision: "v1",
      source: "PDF",
    },
    explanations: [{ review: "Check this" }],
  }));
  const fake = {
    stateDir: store.stateDir,
    find: (id) => reviews.find((r) => r.id === id),
    list: () => reviews,
    get: async (id) => reviews.find((r) => r.id === id),
  };
  let calls = 0,
    uploads = 0;
  const batches = [];
  const fetcher = async (url, options) => {
    calls++;
    if (url.endsWith("/file_uploads"))
      return Response.json({ id: `upload-${++uploads}` });
    if (url.endsWith("/send")) {
      assert.ok(options.body instanceof FormData);
      return Response.json({ status: "uploaded" });
    }
    const payload = JSON.parse(options.body);
    batches.push(payload.children);
    assert.ok(payload.children.length <= 100);
    assert.ok(Buffer.byteLength(options.body) < 450000);
    return Response.json({
      id: "notion-page",
      url: "https://app.notion.com/p/page",
    });
  };
  const ex = new NotionExport(fake, {
    ...config,
    fetcher,
    imageReader: async () => Buffer.from("png"),
  });
  await ex.save("review-0");
  const count = calls;
  await ex.save("review-0");
  assert.equal(calls, count);
  assert.equal(uploads, 100);
  assert.ok(batches.length > 1);
  assert.equal(batches.flat().filter((b) => b.type === "image").length, 100);
  assert.ok(
    batches
      .flat()
      .some((b) => b.type === "code" && JSON.stringify(b).includes("text 99")),
  );
});
test("partial block append stays pending and never reports an incomplete page as saved", async (t) => {
  const { store, review, config } = await fixture(t);
  review.explanations = Array.from({ length: 105 }, () => ({
    review: "finding",
  }));
  store.find(review.id).explanations = review.explanations;
  let calls = 0;
  const ex = new NotionExport(store, {
    ...config,
    fetcher: async (url, options) => {
      calls++;
      return options.method === "PATCH"
        ? new Response("", { status: 500 })
        : Response.json({ id: "page", url: "https://app.notion.com/p/page" });
    },
  });
  await assert.rejects(ex.save(review.id), { status: 502 });
  const count = calls;
  await assert.rejects(ex.save(review.id), { status: 409 });
  assert.equal(calls, count);
});

test("GUI settings persist without exposing keys and take effect without restart", async (t) => {
  const { store, config } = await fixture(t);
  const calls = [];
  const exporter = new NotionExport(store, {
    ...config,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ id: "page", archived: false });
    },
  });
  const configured = await exporter.configure({
    parentPageId: "https://app.notion.com/p/3e5bd1ff57e080148841eed513c01937",
    token: "test-private-key",
  });
  assert.equal(configured.parentPageId, "3e5bd1ff57e080148841eed513c01937");
  assert.equal(configured.hasToken, true);
  assert.equal(JSON.stringify(configured).includes("test-private-key"), false);
  assert.equal((await exporter.checkConnection()).ok, true);
  assert.equal(
    calls[0].url,
    "https://api.notion.com/v1/pages/3e5bd1ff57e080148841eed513c01937",
  );
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer test-private-key",
  );
  const { stat, readFile } = await import("node:fs/promises");
  const path = join(store.stateDir, "notion-settings.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).token,
    "test-private-key",
  );
  const reopened = new NotionExport(store);
  assert.equal(reopened.settings().parentPageId, configured.parentPageId);
  assert.equal(reopened.token, "test-private-key");
  await exporter.configure({ parentPageId: "b".repeat(32), token: "" });
  assert.equal(exporter.token, "test-private-key");
  await assert.rejects(
    exporter.configure({
      parentPageId: "https://example.com/" + "a".repeat(32),
    }),
    { status: 400 },
  );
});

test("connection diagnostics distinguish absent auth, inaccessible and archived pages without writes", async (t) => {
  const { store, config } = await fixture(t);
  await assert.rejects(
    new NotionExport(store, { token: "", parent: "" }).checkConnection(),
    { status: 400 },
  );
  for (const status of [401, 403, 404, 429]) {
    const exporter = new NotionExport(store, {
      ...config,
      fetcher: async (_url, options) => {
        assert.equal(options.method, undefined);
        return new Response("{}", { status });
      },
    });
    await assert.rejects(exporter.checkConnection(), { status: 400 });
  }
  await assert.rejects(
    new NotionExport(store, {
      ...config,
      fetcher: async () => Response.json({ archived: true }),
    }).checkConnection(),
    /ゴミ箱/,
  );
});

test("settings HTTP endpoints require authentication and never serialize the token", async (t) => {
  const { store, config } = await fixture(t);
  const { createServer } = await import("../server/http.mjs");
  const notion = new NotionExport(store, {
    ...config,
    fetcher: async () => Response.json({ archived: false }),
  });
  const server = createServer({
    store,
    token: "api-test",
    notion,
    distDir: store.stateDir,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/api/notion`;
  assert.equal(
    (
      await fetch(url + "/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPageId: "b".repeat(32) }),
      })
    ).status,
    401,
  );
  const headers = {
    Authorization: "Bearer api-test",
    "Content-Type": "application/json",
  };
  const result = await fetch(url + "/settings", {
    method: "POST",
    headers,
    body: JSON.stringify({
      parentPageId: "b".repeat(32),
      token: "private-test-key",
    }),
  });
  assert.equal(result.status, 200);
  assert.equal((await result.text()).includes("private-test-key"), false);
  const status = await (await fetch(url, { headers })).json();
  assert.equal(status.parentPageId, "b".repeat(32));
  assert.equal(status.configured, true);
  assert.equal("token" in status, false);
  const check = await fetch(url + "/check", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(check.status, 200);
});
