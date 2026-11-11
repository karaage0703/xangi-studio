import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ReviewStore } from "../server/store.mjs";

test(
  "renamed managed extension opens existing reviews and Notion settings",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "studio-identity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = join(root, "state");
    const store = await new ReviewStore(join(root, "changes"), state).init();
    const item = await store.create({
      file: "existing.md",
      before: "old",
      content: "saved original",
      readOnly: true,
    });
    const settings = JSON.stringify({
      parentPageId: "123456781234123412341234567890ab",
    });
    await writeFile(join(state, "notion-settings.json"), settings);
    const manifest = JSON.parse(
      await readFile(new URL("../xangi-extension.json", import.meta.url)),
    );
    assert.equal(manifest.id, "xangi-studio");
    assert.equal(manifest.displayName, "xangi-studio");
    const child = spawn(
      process.execPath,
      ["server/extension.mjs", "--workspace", root],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          XANGI_REVIEW_DATA_DIR: root,
          XANGI_EXTENSION_AUTH_TOKEN: "identity-test-token",
          DATA_DIR: root,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    t.after(async () => {
      child.kill("SIGTERM");
      await exited;
    });
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, "line");
    const ready = JSON.parse(line);
    assert.equal(ready.id, manifest.id);
    const health = await (await fetch(`${ready.baseUrl}/health`)).json();
    assert.equal(health.app, "xangi-studio");
    const response = await fetch(`${ready.baseUrl}/api/reviews`, {
      headers: { Authorization: "Bearer identity-test-token" },
    });
    assert.equal(response.status, 200);
    const reviews = await response.json();
    assert.ok(reviews.some((r) => r.id === item.id));
    const saved = await (
      await fetch(`${ready.baseUrl}/api/reviews/${item.id}`, {
        headers: { Authorization: "Bearer identity-test-token" },
      })
    ).json();
    assert.equal(saved.content, "saved original");
    assert.equal(
      await readFile(join(state, "notion-settings.json"), "utf8"),
      settings,
    );
  },
);
