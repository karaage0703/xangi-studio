// Local-only regression fixture: real app and editor, mocked API, no external writes.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
const output = resolve(
  process.env.EDITOR_ARTIFACTS || "artifacts/editor-render",
);
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || "/snap/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let review = {
    id: "render-test",
    file: "draft.txt",
    title: "表示確認",
    source: "web",
    createdAt: new Date().toISOString(),
    history: [],
    before: "元の文章\n",
    content: Array.from(
      { length: 1500 },
      (_, i) =>
        `行${i + 1} 日本語の編集中の文章。 [リンク](https://example.com/${i})`,
    ).join("\n"),
    version: "v1",
    size: 10000,
    modifiedAt: new Date().toISOString(),
  };
  let draft = null;
  let draftRevision = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let data = {};
    if (url.pathname === "/api/reviews") data = [review];
    else if (url.pathname === "/api/reviews/render-test") {
      if (route.request().method() === "PUT")
        review = {
          ...review,
          content: route.request().postDataJSON().content,
          version: "v2",
        };
      data = review;
    } else if (url.pathname === "/api/preferences")
      data = {
        defaultProjectId: null,
        reviewerProjectIds: [],
        archivedChangeSets: [],
      };
    else if (url.pathname === "/api/drafts/review/render-test") {
      if (route.request().method() === "PUT")
        draft = {
          ...route.request().postDataJSON(),
          version: "draft-" + ++draftRevision,
          updatedAt: new Date().toISOString(),
        };
      if (route.request().method() === "DELETE") draft = null;
      data = draft;
    } else if (url.pathname === "/api/review-jobs") data = [];
    else if (url.pathname.endsWith("/requests")) data = [];
    else if (url.pathname.includes("projects")) data = { projects: [] };
    await route.fulfill({ json: data });
  });
  const samples = [];
  for (const mode of ["edit", "preview", "diff"]) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `${server.resolvedUrls.local[0]}?review=render-test&mode=${mode}`,
      );
      await page.locator(".cm-content").first().waitFor();
      await page.waitForTimeout(800);
      for (const y of [0, 1000, 5000, 20000, 35000]) {
        await page.evaluate((y) => scrollTo(0, y), y);
        await page.waitForTimeout(250);
        const sample = await page.evaluate(() => ({
          y: scrollY,
          lines: [...document.querySelectorAll(".cm-line")]
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.top < innerHeight && r.bottom > 0;
            })
            .map((e) => e.textContent),
          gaps: [...document.querySelectorAll(".cm-gap")].map((e) =>
            e.getBoundingClientRect().toJSON(),
          ),
          ancestors: (() => {
            let e = document.querySelector(".cm-content"),
              a = [];
            while (e) {
              a.push({
                tag: e.tagName,
                cls: e.className,
                h: e.clientHeight,
                sh: e.scrollHeight,
                overflow: getComputedStyle(e).overflow,
              });
              e = e.parentElement;
            }
            return a;
          })(),
        }));
        samples.push({ mode, width, ...sample });
        await page.screenshot({
          path: `${output}/${mode}-${width}-scroll-${y}.png`,
        });
      }
      if (mode === "edit") {
        await page.evaluate(() => scrollTo(0, 5000));
        await page.waitForTimeout(250);
        await page.evaluate(() => {
          const line = [...document.querySelectorAll(".cm-line")].find((e) => {
            const r = e.getBoundingClientRect();
            return r.top > 100 && r.bottom < innerHeight - 100;
          });
          if (!line) throw new Error("No editable line in viewport");
          line.dataset.renderEdit = "true";
        });
        const line = page.locator("[data-render-edit]");
        await line.click();
        await page.keyboard.insertText("保存検証");
        const savedDraft = page.waitForResponse(
          (r) =>
            r.url().includes("/api/drafts/review/") &&
            r.request().method() === "PUT",
        );
        await page.keyboard.press("Control+s");
        await savedDraft;
        const saved = page.waitForResponse(
          (r) =>
            r.url().includes("/api/reviews/render-test") &&
            r.request().method() === "PUT",
        );
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await saved;
        await page.getByText("保存しました", { exact: true }).waitFor();
        assert.ok(review.content.includes("保存検証"));
      }
    }
  }
  await writeFile(
    `${output}/samples.json`,
    JSON.stringify({ samples, errors }, null, 2),
  );
  assert.ok(
    samples.every((s) => s.lines.length > 4),
    "visible document must contain rendered lines after page scroll",
  );
  assert.deepEqual(errors, []);
  console.log("PASS: page scroll renders visible editor lines");
} finally {
  await browser?.close();
  await server.close();
}
