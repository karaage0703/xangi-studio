import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewStore } from "../server/store.mjs";
import { createServer } from "../server/http.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "studio-remove-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  return { root, store };
}

test("removing a Studio record preserves shared source files and persists across reload", async (t) => {
  const { root, store } = await fixture(t);
  const old = await store.create({
    file: "shared.md",
    content: "original",
    readOnly: true,
  });
  const kept = await store.create({
    file: "shared.md",
    content: "original",
    readOnly: true,
  });
  assert.equal((await store.remove(old.id)).deleted, true);
  assert.equal(
    await readFile(join(root, "files/shared.md"), "utf8"),
    "original",
  );
  const reloaded = await new ReviewStore(
    join(root, "files"),
    join(root, "state"),
  ).init();
  await assert.rejects(reloaded.get(old.id), { status: 404 });
  assert.equal((await reloaded.get(kept.id)).content, "original");
  assert.deepEqual(
    reloaded.list().map((item) => item.id),
    [kept.id],
  );
});

test("failed deletion persistence restores the record", async (t) => {
  const { store } = await fixture(t);
  const item = await store.create({ file: "keep.md", content: "keep" });
  store.persist = async () => {
    throw new Error("disk unavailable");
  };
  await assert.rejects(store.remove(item.id), /disk unavailable/);
  assert.equal((await store.get(item.id)).content, "keep");
});

test("DELETE waits for an in-flight Notion export", async (t) => {
  const { root, store } = await fixture(t);
  const item = await store.create({ file: "export.md", content: "export" });
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const server = createServer({
    store,
    token: "test",
    distDir: root,
    notion: { save: () => pending },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method) =>
    fetch(base + path, { method, headers: { Authorization: "Bearer test" } });
  const started = await call(`/api/reviews/${item.id}/notion`, "POST");
  assert.equal(started.status, 202);
  const job = await started.json();
  assert.equal((await call(`/api/reviews/${item.id}`, "DELETE")).status, 409);
  finish({ url: "https://example.test/saved" });
  const saved = await (await call(`/api/notion/jobs/${job.id}`, "GET")).json();
  assert.equal(saved.status, "completed");
  assert.equal((await call(`/api/reviews/${item.id}`, "DELETE")).status, 200);
});

test("DELETE requires authentication, rejects active work, and removes only the selected record", async (t) => {
  const { root, store } = await fixture(t);
  const group = {
    kind: "workspace",
    source: "local/test",
    id: "test",
    revision: "v1",
  };
  const old = await store.create({
    file: "old.md",
    content: "old",
    changeSet: group,
  });
  const kept = await store.create({
    file: "keep.md",
    content: "keep",
    changeSet: group,
  });
  let active = true;
  let reviewActive = false;
  const server = createServer({
    store,
    token: "test-only-token",
    distDir: root,
    artifactRequests: { list: () => (active ? [{ status: "running" }] : []) },
    reviewJobs: {
      list: () =>
        reviewActive ? [{ status: "running", changeSet: group }] : [],
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/reviews/${old.id}`;
  const call = (headers = { Authorization: "Bearer test-only-token" }) =>
    fetch(base, { method: "DELETE", headers });
  assert.equal((await call({})).status, 401);
  assert.equal(
    (
      await call({
        Authorization: "Bearer test-only-token",
        "sec-fetch-site": "cross-site",
      })
    ).status,
    403,
  );
  assert.equal((await call()).status, 409);
  active = false;
  reviewActive = true;
  assert.equal((await call()).status, 409);
  reviewActive = false;
  const removed = await call();
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).id, old.id);
  assert.equal((await call()).status, 404);
  assert.equal(
    (
      await fetch(base, {
        headers: { Authorization: "Bearer test-only-token" },
      })
    ).status,
    404,
  );
  assert.equal((await store.get(kept.id)).content, "keep");
});
