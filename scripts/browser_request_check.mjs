// Build first. All xangi work is simulated; no external AI or production state is used.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { ReviewStore } from "../server/store.mjs";
import { DraftStore } from "../server/drafts.mjs";
import { ArtifactRequests } from "../server/artifact-requests.mjs";
import { createServer } from "../server/http.mjs";

const output = resolve(process.env.REQUEST_ARTIFACTS || "artifacts/requests");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "studio-request-browser-"));
const store = await new ReviewStore(
  join(root, "files"),
  join(root, "state"),
).init();
const item = await store.create({
  file: "draft.md",
  title: "説明用の原稿",
  content: "# 原稿\n\n保存済みの本文です。",
});
const reference = await store.create({
  file: "reference.md",
  title: "取り込んだ原本",
  content: "# 閲覧専用の原本",
  readOnly: true,
});
const calls = [],
  runs = new Map();
const options = {
  projects: [{ id: "p", name: "文章プロジェクト" }],
  agents: [{ id: "writer", name: "文章担当" }],
};
let offline = false;
let requests = await new ArtifactRequests(store, {
  options: async () => {
    if (offline) throw new Error("接続を確認してください");
    return options;
  },
  start: async (task, target) => {
    const id = String(calls.length + 1);
    calls.push({ task, target });
    const run = { id, appSessionId: `conversation-${id}`, status: "running" };
    runs.set(id, run);
    return run;
  },
  read: async (id) => runs.get(id),
}).init();
const service = createServer({
  store,
  artifactRequests: requests,
  reviewJobs: { list: () => [] },
  token: "test",
  distDir: resolve("dist"),
});
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  if (
    parsed.pathname === "/api/projects" ||
    parsed.pathname === "/api/agents"
  ) {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(options));
  }
  if (parsed.pathname === "/api/workspaces") {
    res.setHeader("Content-Type", "application/json");
    return res.end('{"workspaces":[]}');
  }
  if (parsed.pathname.startsWith("/chat/"))
    return res.end("xangi conversation fixture");
  if (parsed.pathname.endsWith("/ui")) {
    const html = await readFile("dist/index.html", "utf8");
    res.setHeader("Content-Type", "text/html");
    return res.end(html.replace("<head>", '<head><base href="./service/">'));
  }
  req.url = req.url.replace("/api/extensions/xangi-studio/service", "");
  req.headers.authorization = "Bearer test";
  service.emit("request", req, res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const ui = base + "/api/extensions/xangi-studio/ui";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || "/snap/bin/chromium",
  args: ["--no-sandbox"],
});
let currentPage;
const errors = [];
const checks = [];
async function until(fn) {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("timed out waiting for expected UI state");
}
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    currentPage = page;
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ui + `?review=${item.id}&mode=preview`);
    const panel = page.getByRole("region", { name: "xangiへの依頼" });
    await panel.getByText("xangiへ依頼", { exact: true }).first().click();
    await panel
      .getByLabel("依頼先", { exact: true })
      .selectOption("agent:writer");
    const input = panel.getByLabel("依頼内容（必須）", { exact: true });
    const button = panel.getByRole("button", {
      name: "xangiへ依頼",
      exact: true,
    });
    assert.equal(await button.isDisabled(), true);
    await input.fill(`結論を先にして ${width}`);
    await until(async () => button.isEnabled());
    await button.click();
    await panel
      .getByRole("link", { name: "xangiの会話を開く" })
      .first()
      .waitFor();
    assert.equal(
      await panel.getByRole("button", { name: "xangiが作業中" }).isDisabled(),
      true,
    );
    const last = calls.length;
    assert.equal(calls[last - 1].target.agentId, "writer");
    assert.match(calls[last - 1].task, /保存済みの本文/);
    await page.screenshot({
      path: join(output, `running-${width}.png`),
      fullPage: true,
    });
    await page.reload();
    await panel
      .getByRole("link", { name: "xangiの会話を開く" })
      .first()
      .waitFor();
    assert.equal(calls.length, last);
    runs.set(String(last), {
      status: "succeeded",
      result:
        "# 修正しました\n\n結論を先にした原稿です。<script>window.bad=true</script>",
    });
    await requests.collect();
    const currentWork = panel.locator("li").filter({
      has: page.getByText(`結論を先にして ${width}`, { exact: true }),
    });
    await currentWork.getByText("完了", { exact: true }).waitFor();
    await currentWork.getByText("回答を読む", { exact: true }).click();
    await currentWork.getByRole("heading", { name: "修正しました" }).waitFor();
    assert.equal(await page.evaluate(() => window.bad), undefined);
    await page.screenshot({
      path: join(output, `result-${width}.png`),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    const popupPromise = page.waitForEvent("popup");
    await panel
      .getByRole("link", { name: "xangiの会話を開く" })
      .first()
      .click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.match(popup.url(), /\/chat\/conversation-/);
    await popup.close();
    // The retained manual editor is supplementary; requests cannot ignore pending drafts.
    await page.getByRole("tab", { name: "編集", exact: true }).click();
    await page
      .getByRole("textbox", { name: "ファイルを編集", exact: true })
      .fill(`未反映の下書き ${width}`);
    await panel.locator("summary").first().click();
    await input.fill("下書きを無視して依頼しない");
    assert.equal(await button.isDisabled(), true);
    await panel
      .getByText("未反映の下書きがあります。保存してから依頼してください。", {
        exact: true,
      })
      .waitFor();
    const bar = page.getByLabel("下書きの保存状態", { exact: true });
    await until(async () => (await bar.innerText()).includes("保存済み"));
    await page.reload();
    await page
      .getByRole("textbox", { name: "ファイルを編集", exact: true })
      .waitFor();
    assert.match(
      await page
        .getByRole("textbox", { name: "ファイルを編集", exact: true })
        .innerText(),
      /未反映の下書き/,
    );
    if (width === 390)
      await page
        .getByRole("button", { name: "サイドバーを開く", exact: true })
        .first()
        .click();
    const list = page.getByRole("navigation", {
      name: "成果物一覧",
      exact: true,
    });
    if (!(await list.isVisible()))
      await page
        .getByRole("button", { name: "サイドバーを開く", exact: true })
        .first()
        .click();
    await list.getByRole("link", { name: /取り込んだ原本/ }).click();
    await page.getByRole("region", { name: "xangiへの依頼" }).waitFor();
    await page.waitForURL(
      (url) => url.searchParams.get("review") === reference.id,
    );
    await page
      .locator(".file-header")
      .getByText("reference.md", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("tab", { name: "編集", exact: true }).count(),
      0,
    );
    checks.push({
      width,
      request: "passed",
      reload: "passed",
      answer: "passed",
      conversation: "passed",
      draftGuard: "passed",
      navigation: "passed",
    });
    await context.close();
    const drafts = new DraftStore(store.stateDir);
    const pendingDraft = await drafts.read("review", item.id);
    if (pendingDraft)
      await drafts.remove("review", item.id, pendingDraft.version);
  }
  assert.equal((await store.get(item.id)).content, item.content);
  assert.deepEqual(errors, []);
  const record = {
    checks,
    calls: calls.length,
    pageErrors: errors,
    originalUnchanged: true,
  };
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(record, null, 2),
  );
  console.log(JSON.stringify(record));
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({
      path: join(output, "failure.png"),
      fullPage: true,
    });
    await writeFile(join(output, "failure.html"), await currentPage.content());
  }
  throw error;
} finally {
  await browser.close();
  requests.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}
