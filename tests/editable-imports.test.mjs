import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../server/store.mjs";
import { createServer } from "../server/http.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "studio-editable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "files"),
    state = join(dir, "state");
  return { root, state, store: await new ReviewStore(root, state).init() };
}
const changeSet = (kind) => ({
  kind,
  source: "local/example",
  id: "sample",
  revision: "rev1",
});

test("text imports are editable by default, including legacy readOnly requests", async (t) => {
  const { store } = await fixture(t);
  for (const kind of ["workspace", "github-pr", "github-repository"]) {
    const item = await store.create({
      file: `drafts/${kind}.md`,
      content: "imported",
      before: "baseline",
      readOnly: true,
      changeSet: changeSet(kind),
    });
    assert.equal(item.readOnly, false);
    const saved = await store.save(item.id, "edited");
    assert.equal(saved.content, "edited");
    assert.equal(saved.before, "baseline");
    assert.equal(
      store.snapshot(item.id, saved.history.at(-1).id).content,
      "imported",
    );
    assert.equal(store.importedRevision(item.changeSet), "rev1");
    const updated = await store.updateImported(item.file, {
      title: "updated",
      changeSet: item.changeSet,
    });
    assert.equal(updated.id, item.id);
    assert.equal(updated.content, "edited");
    const additional = await store.create({
      file: `drafts/${kind}-additional.md`,
      content: "newly imported",
      readOnly: true,
      changeSet: changeSet(kind),
    });
    assert.equal(
      additional.changeSet.editRevision,
      saved.changeSet.editRevision,
    );
  }
  const locked = await store.create({
    file: "locked.md",
    content: "locked",
    readOnly: true,
  });
  await assert.rejects(store.save(locked.id, "edited"), { status: 403 });
});

test("existing workspace links become editable on restart without losing baseline or history", async (t) => {
  const { store, root, state } = await fixture(t);
  const item = await store.create({
    file: "drafts/readme.md",
    content: "snapshot",
    before: "before",
    changeSet: changeSet("workspace"),
  });
  const persisted = JSON.parse(
    await readFile(join(state, "reviews.json"), "utf8"),
  );
  persisted[0].readOnly = true;
  await writeFile(join(state, "reviews.json"), JSON.stringify(persisted));
  const reopened = await new ReviewStore(root, state).init();
  const loaded = await reopened.get(item.id);
  assert.equal(loaded.readOnly, false);
  assert.equal(loaded.before, item.before);
  assert.deepEqual(loaded.history, item.history);
  await reopened.save(item.id, "after restart");
  assert.equal(
    (await new ReviewStore(root, state).init()).find(item.id).readOnly,
    false,
  );
});

test("imported text supports draft restoration and explicit save over HTTP", async (t) => {
  const { store, root } = await fixture(t);
  const item = await store.create({
    file: "drafts/api.md",
    content: "snapshot",
    readOnly: true,
    changeSet: changeSet("workspace"),
  });
  const server = createServer({ store, token: "test", distDir: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (path, content) =>
    fetch(base + path, {
      method: "PUT",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
  assert.equal(
    (await put(`/api/drafts/review/${item.id}`, "draft")).status,
    200,
  );
  assert.equal((await store.get(item.id)).content, "snapshot");
  const response = await put(`/api/reviews/${item.id}`, "saved 日本語");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, "saved 日本語");
  assert.equal(await readFile(join(root, item.file), "utf8"), "saved 日本語");
});
