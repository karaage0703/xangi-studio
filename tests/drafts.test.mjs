import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DraftStore } from "../server/drafts.mjs";
import { ReviewStore } from "../server/store.mjs";
import { createServer } from "../server/http.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "draft-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("下書きは版の指定なしで最後の保存を採用し、再起動後も保持する", async (t) => {
  const root = await fixture(t);
  const store = new DraftStore(root);
  const results = await Promise.all([
    store.save("review", "task", { content: "a" }),
    store.save("review", "task", { content: "b" }),
  ]);
  assert.equal(results.length, 2);
  assert.equal(
    (await new DraftStore(root).read("review", "task")).content,
    "b",
  );
  const next = await store.save("review", "task", {
    content: "{ incomplete JSON",
  });
  assert.equal(next.content, "{ incomplete JSON");
  await store.remove("review", "task");
  assert.equal(await store.read("review", "task"), null);
});
test("invalid or oversized drafts cannot replace a persisted draft", async (t) => {
  const root = await fixture(t);
  const store = new DraftStore(root);
  const saved = await store.save("review", "id", { content: "keep" });
  for (const content of ["a".repeat(1024 * 1024 + 1), null, 1])
    await assert.rejects(store.save("review", "id", { content }), {
      status: 400,
    });
  assert.throws(() => store.path("review", "../escape"), { status: 400 });
  assert.throws(() => store.path("other", "id"), { status: 400 });
  assert.deepEqual(await store.read("review", "id"), saved);
});
test("draft API enforces auth/read-only and never applies to files or source files", async (t) => {
  const root = await fixture(t);
  const store = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  const item = await store.create({ file: "a.md", content: "original" });
  const ro = await store.create({
    file: "b.md",
    content: "reference",
    readOnly: true,
  });
  const server = createServer({ store, token: "test", distDir: root });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = "GET", body, auth = true) =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer test" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal(
    (await call(`/api/drafts/review/${item.id}`, "GET", undefined, false))
      .status,
    401,
  );
  assert.equal((await call(`/api/drafts/review/${ro.id}`)).status, 403);
  const body = {
    content: "unfinished",
  };
  assert.equal(
    (await call(`/api/drafts/review/${item.id}`, "PUT", body)).status,
    200,
  );
  assert.equal((await store.get(item.id)).content, "original");
  assert.equal((await store.get(item.id)).history.length, item.history.length);
  assert.equal(
    (await call("/api/drafts/studio/task", "PUT", body)).status,
    404,
  );
  assert.equal(
    (await call(`/api/drafts/review/${item.id}`, "PUT", body)).status,
    200,
  );
});
