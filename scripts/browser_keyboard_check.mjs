// Local-only editor fixture. Mobile flow layout must not depend on keyboard geometry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
const output = resolve(
  process.env.KEYBOARD_ARTIFACTS || "/tmp/studio-keyboard-check",
);
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["scripts/draft-browser-server.mjs"], {
  stdio: ["ignore", "pipe", "inherit"],
});
let browser;
try {
  const lines = createInterface({ input: server.stdout });
  const [line] = await once(lines, "line");
  lines.close();
  const info = JSON.parse(line),
    base = `http://127.0.0.1:${info.port}`;
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || "/snap/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const results = [];
  for (const width of [390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      let height = innerHeight,
        scale = 1;
      Object.defineProperties(visualViewport, {
        height: { get: () => height },
        scale: { get: () => scale },
      });
      window.simulateViewport = (h, s = 1) => {
        height = h;
        scale = s;
        visualViewport.dispatchEvent(new Event("resize"));
      };
    });
    await page.goto(
      `${base}/api/extensions/xangi-studio/ui?review=${info.reviewId}&mode=edit`,
    );
    const bar = page.getByLabel("下書きの保存状態", { exact: true }),
      editor = page.getByRole("textbox", {
        name: "ファイルを編集",
        exact: true,
      });
    await bar
      .getByText("下書き · 保存済み", { exact: true })
      .waitFor({ state: "attached" });
    const position = await bar.evaluate((e) => getComputedStyle(e).position);
    assert.equal(position, width <= 800 ? "static" : "fixed");
    if (width <= 800) {
      await editor.fill("長い本文の確認\n".repeat(600));
      await bar.getByText("下書き · 保存済み", { exact: true }).waitFor();
      // The footer follows the whole editor, even with no viewport shrink or with zoom.
      const assertAfterEditor = async () => {
        const bounds = await page.evaluate(() => ({
          footer: document
            .querySelector(".draft-status-bar")
            .getBoundingClientRect().top,
          editor: document
            .querySelector("#file-content")
            .getBoundingClientRect().bottom,
        }));
        assert.ok(bounds.footer >= bounds.editor - 1, JSON.stringify(bounds));
      };
      await editor.focus();
      await assertAfterEditor();
      await page.evaluate(() => simulateViewport(430, 2));
      await assertAfterEditor();
      assert.equal(
        await bar.evaluate((e) => getComputedStyle(e).display),
        "flex",
      );
      await page.evaluate(() => simulateViewport(430));
      await assertAfterEditor();
      await page.setViewportSize({ width, height: 430 });
      await assertAfterEditor();
      // Scroll halfway through a long document: no footer overlays the visible editor.
      await page.evaluate(() =>
        scrollTo(0, document.documentElement.scrollHeight / 2),
      );
      assert.ok((await bar.boundingBox()).y >= 430);
      await page.screenshot({ path: output + `/editing-${width}.png` });
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => simulateViewport(900));
      await bar.scrollIntoViewIfNeeded();
      await page.screenshot({ path: output + `/footer-${width}.png` });
      // Normal flow must also follow a short editor; saving remains a single action.
      const savedText = `末尾の保存ボタンから保存😀 ${width}`;
      await editor.fill(savedText);
      await bar.getByText("下書き · 保存済み", { exact: true }).waitFor();
      await assertAfterEditor();
      await bar.getByRole("button", { name: "保存", exact: true }).click();
      await page.getByText("保存しました", { exact: true }).waitFor();
      assert.equal(
        (await (await page.request.get(base + "/stats")).json()).review.content,
        savedText,
      );
    } else {
      await editor.focus();
      await page.evaluate(() => simulateViewport(430));
      assert.equal(await bar.isVisible(), true);
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    results.push({ width, position, editorOverlap: false, pageErrors: errors });
    await page.close();
  }
  console.log(JSON.stringify(results));
} finally {
  await browser?.close();
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await exited;
}
