// Local fixture with the host's measured CSP/proxy restrictions. No production writes.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { ReviewStore } from "../server/store.mjs";
import { DraftStore } from "../server/drafts.mjs";
import { createServer } from "../server/http.mjs";
import { githubGroupKey } from "../shared/pr-label.mjs";

const output = resolve(
  process.env.HTML_PREVIEW_ARTIFACTS || "artifacts/html-preview",
);
await mkdir(output, { recursive: true });
const dir = await mkdtemp(join(tmpdir(), "studio-html-browser-"));
let browser, server, currentPage;
const checks = [],
  errors = [],
  unexpectedRequests = [];
try {
  const store = await new ReviewStore(
    join(dir, "files"),
    join(dir, "state"),
  ).init();
  const html = `<!doctype html><html lang="ja"><head><title>HTML sample</title><link rel="stylesheet" href="./css/main.css"><script src="./app.js" defer></script></head><body data-theme="preview"><h1 class="demo">HTMLを表示</h1><button id="count">0</button><script type="module" src="./simple.mjs"></script><img src="/trap-image"><script>
    try { parent.document.body.dataset.previewEscaped = 'bad'; } catch { document.body.dataset.parentBlocked='yes'; }
    try { localStorage.getItem('xangi-editor-key'); } catch { document.body.dataset.storageBlocked='yes'; }
    fetch('/trap-api', {method:'POST',body:'blocked'}).catch(()=>document.body.dataset.networkBlocked='yes');
  </script></body></html>`;
  const content = {
    "index.html": html,
    "css/main.css":
      "@import './palette.css'; .demo { color: rgb(1, 2, 3); background-image: url('../icon.svg'); }",
    "css/palette.css": "body { background: rgb(240, 241, 242); }",
    "icon.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0"/></svg>',
    "app.js":
      "document.querySelector('#count').onclick = e => e.target.textContent = String(Number(e.target.textContent)+1);",
    "simple.mjs":
      "export const value = 'loaded'; document.body.dataset.module=value;",
  };
  const sets = [];
  for (const kind of ["workspace", "github-repository"]) {
    const changeSet = {
      kind,
      id: kind,
      source: "example/site",
      title: kind,
      revision: "revision",
      url: "https://github.com/example/site",
    };
    const root =
      kind === "workspace"
        ? "drafts/site"
        : "changes/github/example-site/repo-abcd/revision";
    for (const [name, text] of Object.entries(content)) {
      const item = await store.create({
        file: `${root}/${name}`,
        content: text,
        changeSet,
      });
      if (name === "index.html") sets.push(item);
    }
  }
  const markdown = await store.create({
    file: "drafts/readme.md",
    content: "# Markdown is unchanged",
  });
  let sample;
  if (process.env.HTML_PREVIEW_SAMPLE) {
    const data = JSON.parse(
      await readFile(process.env.HTML_PREVIEW_SAMPLE, "utf8"),
    );
    sample = await store.create({
      file: "drafts/bundled-game.html",
      content: data.content,
    });
  }
  const service = createServer({
    store,
    token: "test",
    distDir: resolve("dist"),
    reviewJobs: { list: () => [] },
  });
  let failPreview = false;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/trap")) {
      unexpectedRequests.push(url.pathname);
      res.writeHead(500);
      return res.end();
    }
    if (
      ["/api/projects", "/api/agents", "/api/workspaces"].includes(url.pathname)
    ) {
      res.setHeader("Content-Type", "application/json");
      return res.end('{"projects":[],"agents":[],"workspaces":[]}');
    }
    if (url.pathname.endsWith("/ui")) {
      res.setHeader("Content-Type", "text/html");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
      );
      return res.end(
        (await readFile("dist/index.html", "utf8")).replace(
          "<head>",
          '<head><base href="./service/">',
        ),
      );
    }
    if (url.pathname.startsWith("/api/extensions/xangi-studio/service/")) {
      // The real proxy rejects opaque-origin subresource requests. Preview
      // resources must therefore be inline, not fetched from the extension.
      if (req.headers["sec-fetch-site"] === "cross-site") {
        unexpectedRequests.push(url.pathname);
        res.writeHead(403);
        return res.end();
      }
      req.url = req.url.replace("/api/extensions/xangi-studio/service", "");
      req.headers.authorization = "Bearer test";
    }
    if (failPreview && req.url.endsWith("/preview-files")) {
      failPreview = false;
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end('{"error":"preview failure fixture"}');
    }
    service.emit("request", req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ui = base + "/api/extensions/xangi-studio/ui";
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || "/snap/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    currentPage = page;
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e) => errors.push(e.message));
    const item = sets[0];
    await page.goto(`${ui}?review=${item.id}&mode=preview`);
    let frame = page.frameLocator(".html-preview iframe");
    await frame.getByRole("heading", { name: "HTMLを表示" }).waitFor();
    await frame
      .locator(
        'body[data-module="loaded"][data-parent-blocked="yes"][data-storage-blocked="yes"][data-network-blocked="yes"]',
      )
      .waitFor();
    assert.equal(
      await frame.locator("h1").evaluate((e) => getComputedStyle(e).color),
      "rgb(1, 2, 3)",
    );
    assert.equal(
      await frame
        .locator("body")
        .evaluate((e) => getComputedStyle(e).backgroundColor),
      "rgb(240, 241, 242)",
    );
    await frame.locator("#count").click();
    assert.equal(await frame.locator("#count").innerText(), "1");
    assert.equal(
      await page.evaluate(() => document.body.dataset.previewEscaped),
      undefined,
    );
    assert.equal(
      await page.locator(".html-preview iframe").getAttribute("sandbox"),
      "allow-scripts",
    );
    await page.screenshot({ path: join(output, `render-${width}.png`) });
    await page.getByRole("tab", { name: "編集", exact: true }).click();
    const editor = page.getByRole("textbox", {
      name: "ファイルを編集",
      exact: true,
    });
    await editor.fill(
      "<h1>編集したHTML</h1><button onclick=\"this.textContent='動作済み'\">動作確認</button>",
    );
    await page.getByRole("tab", { name: "表示", exact: true }).click();
    await page
      .frameLocator(".html-preview iframe")
      .getByRole("heading", { name: "編集したHTML" })
      .waitFor();
    assert.equal((await store.get(item.id)).content, html);
    await page
      .getByRole("button", { name: "保存", exact: true })
      .scrollIntoViewIfNeeded();
    await page
      .getByText("下書き · 保存済み", { exact: true })
      .waitFor({ state: "attached" });
    await page.waitForTimeout(200);
    const savedResponse = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/reviews/${item.id}`) &&
        r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const response = await savedResponse;
    console.log(
      "saved",
      width,
      response.status(),
      (await response.json()).content?.slice(0, 80),
    );
    await page
      .getByText("保存しました", { exact: true })
      .waitFor({ state: "attached" });
    await page.reload();
    await page
      .frameLocator(".html-preview iframe")
      .getByRole("heading", { name: "編集したHTML" })
      .waitFor();
    await store.save(item.id, html);
    await new DraftStore(store.stateDir).save("review", item.id, {
      content: html,
    });
    const repo = sets[1];
    await page.goto(
      `${ui}?pr=${encodeURIComponent(githubGroupKey(repo.changeSet))}`,
    );
    const repository = page.getByLabel("リポジトリのファイル", { exact: true });
    const openFiles = repository.getByRole("button", {
      name: "ファイル一覧を開く",
      exact: true,
    });
    if (width === 390) await openFiles.click();
    await repository
      .locator(".file-item")
      .filter({ has: page.locator("strong", { hasText: /^index\.html$/ }) })
      .click();
    frame = page.frameLocator(".html-preview iframe");
    await frame.getByRole("heading", { name: "HTMLを表示" }).waitFor();
    await page.getByRole("button", { name: "ソース表示", exact: true }).click();
    await page
      .locator(".repository-source .cm-content")
      .waitFor({ state: "attached" });
    assert.equal(await page.locator(".html-preview iframe").count(), 0);
    await page.getByRole("button", { name: "表示", exact: true }).click();
    await page
      .frameLocator(".html-preview iframe")
      .getByRole("heading", { name: "HTMLを表示" })
      .waitFor();
    failPreview = true;
    await page
      .getByRole("button", { name: "プレビューを再読み込み", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "preview failure fixture" })
      .waitFor();
    await page
      .getByRole("button", { name: "プレビューを再読み込み", exact: true })
      .click();
    await page
      .frameLocator(".html-preview iframe")
      .getByRole("heading", { name: "HTMLを表示" })
      .waitFor();
    await page.goto(`${ui}?review=${markdown.id}&mode=preview`);
    await page
      .getByRole("heading", { name: "Markdown is unchanged" })
      .waitFor();
    if (sample) {
      await page.goto(`${ui}?review=${sample.id}&mode=preview`);
      frame = page.frameLocator(".html-preview iframe");
      await frame.locator("#attack").waitFor();
      const before = await frame.locator("#hp-text").innerText();
      await frame.locator("#attack").click();
      await page.waitForTimeout(100);
      assert.notEqual(await frame.locator("#hp-text").innerText(), before);
      await page.screenshot({ path: join(output, `game-${width}.png`) });
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    checks.push({
      width,
      linkedCssAndJs: true,
      scriptIsolation: true,
      draftAndSave: true,
      repositoryPreview: true,
      retry: true,
      markdown: true,
      bundledGame: !!sample,
    });
    await page.close();
  }
  const page = await browser.newPage();
  currentPage = page;
  await page.goto(`${base}/?review=${sets[0].id}&mode=preview#key=test`);
  await page
    .frameLocator(".html-preview iframe")
    .getByRole("heading", { name: "HTMLを表示" })
    .waitFor();
  checks.push({ standaloneCsp: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  console.log(JSON.stringify({ checks, errors, unexpectedRequests }));
} catch (error) {
  if (currentPage)
    await writeFile(
      join(output, "failure-ui.json"),
      JSON.stringify(
        await currentPage.evaluate(() => ({
          url: location.href,
          text: document.body.innerText,
          frames: [...document.querySelectorAll("iframe")].map((x) => x.src),
        })),
        null,
        2,
      ),
    ).catch(() => {});
  await currentPage
    ?.screenshot({ path: join(output, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ checks, errors, unexpectedRequests }, null, 2),
  );
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
