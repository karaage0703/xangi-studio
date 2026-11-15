import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedDataDir } from "../server/data-path.mjs";

test("managed data stays outside source and preserves explicit destinations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "studio-data-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    XDG_STATE_HOME: join(dir, "persistent"),
    XANGI_EXTENSION_INSTANCE_ID: "a",
  };
  const a = managedDataDir(env);
  assert.ok(a.startsWith(env.XDG_STATE_HOME + "/"));
  assert.notEqual(
    a,
    managedDataDir({ ...env, XANGI_EXTENSION_INSTANCE_ID: "b" }),
  );
  assert.equal(managedDataDir({ ...env, XANGI_REVIEW_DATA_DIR: dir }), dir);
});
