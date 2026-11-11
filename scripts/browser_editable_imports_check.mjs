// Isolated real server and browser. No upstream writes, AI calls or production data.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { ReviewStore } from "../server/store.mjs";
import { createServer } from "../server/http.mjs";

const output = resolve(
  process.env.EDITABLE_ARTIFACTS || "artifacts/editable-imports",
);
await mkdir(output, { recursive: true });
const dir = await mkdtemp(join(tmpdir(), "studio-editable-browser-"));
let browser, server;
const errors = [],
  checks = [];
try {
  const store = await new ReviewStore(
    join(dir, "files"),
    join(dir, "state"),
  ).init();
  const items = [];
  for (const kind of ["workspace", "github-pr", "github-repository"]) {
    items.push(
      await store.create({
        file: `drafts/${kind}.md`,
        title: `${kind} sample`,
        content: "# Imported text\n\nCurrent text\n",
        before: "# Before\n",
        readOnly: true,
        changeSet: {
          kind,
          id: kind,
          title: kind,
          source: "local/sample",
          revision: "rev1",
          url: "https://github.com/example/sample/pull/1",
        },
      }),
    );
  }
  const locked = await store.create({
    file: "locked.md",
    content: "locked text",
    readOnly: true,
  });
  const service = createServer({
    store,
    token: "test",
    distDir: resolve("dist"),
    reviewJobs: { list: () => [] },
  });
  let failSave = false;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (
      ["/api/projects", "/api/agents", "/api/workspaces"].includes(url.pathname)
    ) {
      res.setHeader("Content-Type", "application/json");
      return res.end('{"projects":[],"agents":[],"workspaces":[]}');
    }
    if (url.pathname.endsWith("/ui")) {
      res.setHeader("Content-Type", "text/html");
      return res.end(
        (await readFile("dist/index.html", "utf8")).replace(
          "<head>",
          '<head><base href="./service/">',
        ),
      );
    }
    if (url.pathname.endsWith("/github-description")) {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          title: "Fixture PR",
          body: "Local test description",
          url: "https://github.com/example/sample/pull/1",
        }),
      );
    }
    req.url = req.url.replace("/api/extensions/xangi-studio/service", "");
    if (
      failSave &&
      req.method === "PUT" &&
      req.url.startsWith("/api/reviews/")
    ) {
      failSave = false;
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "保存失敗の検証" }));
    }
    req.headers.authorization = "Bearer test";
    service.emit("request", req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ui = `http://127.0.0.1:${server.address().port}/api/extensions/xangi-studio/ui`;
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || "/snap/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e) => errors.push(e.message));
    for (const item of items) {
      const mode =
        item.changeSet.kind === "github-repository" ? "edit" : "diff";
      await page.goto(`${ui}?review=${item.id}&mode=${mode}`);
      const editor = page.locator('.cm-content[contenteditable="true"]');
      await editor.waitFor();
      if (width === 1440 && mode === "diff")
        assert.equal(
          await page
            .locator('.cm-merge-a .cm-content[contenteditable="false"]')
            .count(),
          1,
        );
      const text = `\n編集済み 日本語😀 ${width} ${item.changeSet.kind}`;
      await editor.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.insertText(text);
      await page.getByText("下書き · 保存済み", { exact: true }).waitFor();
      assert.ok(!(await store.get(item.id)).content.includes(text));
      await page.reload();
      await editor.waitFor();
      await page.waitForFunction(
        (text) =>
          [
            ...document.querySelectorAll('.cm-content[contenteditable="true"]'),
          ].some((e) => e.textContent.includes(text.trim())),
        text,
      );
      const save = page.getByRole("button", { name: "保存", exact: true });
      if (item.changeSet.kind === "workspace") {
        failSave = true;
        await save.click();
        await page.getByText("保存失敗の検証", { exact: true }).waitFor();
        assert.ok(!(await store.get(item.id)).content.includes(text));
      }
      await save.click();
      await page.getByText("保存しました", { exact: true }).waitFor();
      assert.ok((await store.get(item.id)).content.includes(text));
      assert.equal((await store.get(item.id)).before, item.before);
      await page.screenshot({
        path: join(output, `${item.changeSet.kind}-${width}.png`),
        fullPage: true,
      });
      await page.reload();
      await editor.waitFor();
      assert.ok((await store.get(item.id)).content.includes(text));
      await page.getByRole("tab", { name: "表示", exact: true }).click();
      assert.equal(
        await page.locator('.cm-content[contenteditable="true"]').count(),
        0,
      );
      await page.getByRole("tab", { name: "編集", exact: true }).click();
      await editor.waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      checks.push({
        width,
        kind: item.changeSet.kind,
        draftRestore: true,
        saved: true,
        baselinePreserved: true,
      });
    }
    await page.goto(`${ui}?review=${locked.id}&mode=diff`);
    await page.locator(".cm-content").first().waitFor();
    assert.equal(
      await page.locator('.cm-content[contenteditable="true"]').count(),
      0,
    );
    assert.equal(
      await page.getByRole("tab", { name: "編集", exact: true }).count(),
      0,
    );
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally {
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
