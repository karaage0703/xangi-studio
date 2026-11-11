import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewStore } from "../server/store.mjs";
import { createServer } from "../server/http.mjs";
import { HtmlPreviews, MAX_PREVIEW_BYTES } from "../server/html-previews.mjs";

test("preview capabilities expire, are bounded, and reject invalid or oversized content", () => {
  let now = 0;
  const previews = new HtmlPreviews({ now: () => now, ttl: 100, limit: 2 });
  const a = previews.create("first").path.split("/").at(-1);
  const b = previews.create("second").path.split("/").at(-1);
  assert.notEqual(a, b);
  previews.create("third");
  assert.throws(() => previews.read(a), { status: 404 });
  assert.equal(previews.read(b), "second");
  now = 101;
  assert.throws(() => previews.read(b), { status: 404 });
  assert.throws(() => previews.create(null), { status: 400 });
  assert.throws(() => previews.create("a".repeat(MAX_PREVIEW_BYTES + 1)), {
    status: 413,
  });
});

test("HTML preview snapshots require authentication, preserve sources, and carry a sandbox policy", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "html-preview-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await new ReviewStore(
    join(dir, "files"),
    join(dir, "state"),
  ).init();
  const changeSet = {
    kind: "workspace",
    id: "site",
    source: "local/site",
    revision: "one",
  };
  const html = await store.create({
    file: "drafts/site/index.html",
    content: "<h1>original</h1>",
    changeSet,
  });
  await store.create({
    file: "drafts/site/main.js",
    content: "console.log('same set')",
    changeSet,
  });
  await store.create({
    file: "drafts/other/secret.js",
    content: "other set",
    changeSet: { ...changeSet, id: "other" },
  });
  await store.create({
    file: "drafts/old/main.js",
    content: "other revision",
    changeSet: { ...changeSet, revision: "old" },
  });
  const server = createServer({ store, token: "test", distDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    Authorization: "Bearer test",
    "Content-Type": "application/json",
  };
  const path = `/api/reviews/${html.id}/preview-files`;
  assert.equal((await fetch(base + path)).status, 401);
  const sources = await (await fetch(base + path, { headers })).json();
  assert.deepEqual(
    sources.files.map((x) => x.file),
    ["drafts/site/main.js"],
  );
  assert.equal(
    (await fetch(base + "/api/html-previews", { method: "POST", body: "{}" }))
      .status,
    401,
  );
  const created = await fetch(base + "/api/html-previews", {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "<h1>preview draft</h1>" }),
  });
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.match(result.path, /^\/html-preview\/[a-f0-9]{48}$/);
  const preview = await fetch(base + result.path);
  assert.equal(preview.status, 200);
  assert.equal(await preview.text(), "<h1>preview draft</h1>");
  const csp = preview.headers.get("content-security-policy");
  assert.match(csp, /sandbox allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.equal(preview.headers.get("referrer-policy"), "no-referrer");
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.equal(
    (await fetch(base + result.path, { method: "POST" })).status,
    405,
  );
  assert.equal(
    (await fetch(base + "/html-preview/" + "0".repeat(48))).status,
    404,
  );
  assert.equal((await store.get(html.id)).content, "<h1>original</h1>");
  assert.equal((await store.get(html.id)).history.length, html.history.length);
});
