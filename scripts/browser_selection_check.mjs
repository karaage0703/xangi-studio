// Isolated check of the real CodePane, without a backend or external writes.
// BROWSER_EXECUTABLE=/snap/bin/chromium node scripts/browser_selection_check.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const output = resolve(
  process.env.SELECTION_ARTIFACTS || "artifacts/selection",
);
await mkdir(output, { recursive: true });
const server = await createServer({
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "selection-fixture",
      configureServer(server) {
        server.middlewares.use("/selection-check", async (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/selection-check",
              '<html><head></head><body><div id="root"></div></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || "/snap/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 700 },
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const color of ["light", "dark"]) {
    for (const mode of ["edit", "read", "diff", "diff-right", "mobile-diff"]) {
      await page.setViewportSize({
        width: mode === "mobile-diff" ? 390 : 1100,
        height: 700,
      });
      await page.goto(`${server.resolvedUrls.local[0]}selection-check`);
      await page.evaluate(
        async ({ color, mode }) => {
          const ReactModule = await import("/node_modules/.vite/deps/react.js");
          const React = ReactModule.default || ReactModule;
          const ReactDOM =
            await import("/node_modules/.vite/deps/react-dom_client.js");
          const { createRoot } = ReactDOM.default || ReactDOM;
          const { CodePane } = await import("/src/CodePane.tsx");
          const { EditorView } =
            await import("/node_modules/.vite/deps/@codemirror_view.js");
          await import("/src/styles.css");
          document.documentElement.dataset.theme = color;
          document.querySelector("#root").style.height = "500px";
          window.editor = () =>
            EditorView.findFromDOM(
              document.querySelectorAll(".cm-content")[
                mode === "diff-right" ? 1 : 0
              ],
            );
          createRoot(document.querySelector("#root")).render(
            React.createElement(CodePane, {
              content: 'const sample = "abcdefghijk";\nconst second = 2;\n',
              before: 'const sample = "abcdefOLDjk";\nconst second = 1;\n',
              file: "sample.ts",
              mode: mode.includes("diff") ? "diff" : mode,
              mobile: mode === "mobile-diff",
              resetKey: "selection-test",
            }),
          );
        },
        { color, mode },
      );
      await page.locator(".cm-content").first().waitFor();
      const coords = await page.evaluate(() =>
        [4, 10, 38].map((pos) => window.editor().coordsAtPos(pos)),
      );
      const y = (coords[0].top + coords[0].bottom) / 2;
      await page.mouse.click(coords[0].left, y);
      // Sample only the background between glyphs and the line's top edge.
      const clip = {
        x: Math.ceil(coords[0].left + 3),
        y: Math.ceil(coords[0].top),
        width: 20,
        height: 2,
      };
      const baseline = await page.screenshot({ clip });
      await page.mouse.move(coords[0].left, y);
      await page.mouse.down();
      await page.mouse.move(coords[1].left, y, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(100);
      const selection = await page.evaluate(() => ({
        text: window.getSelection().toString(),
        range: window.editor().state.selection.main.toJSON(),
      }));
      assert.equal(
        selection.text,
        "t samp",
        `${color}/${mode}: mouse selection text`,
      );
      await page.keyboard.press("Control+c");
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        "t samp",
      );
      const selected = await page.screenshot({ clip });
      await page.screenshot({ path: `${output}/${color}-${mode}.png` });
      assert.ok(
        !baseline.equals(selected),
        `${color}/${mode}: same-line selection must be visible`,
      );
      await page.mouse.click(coords[1].right + 40, y);
      await page.mouse.click(coords[0].left, y);
      await page.keyboard.down("Shift");
      await page.mouse.click(coords[1].left, y);
      await page.keyboard.up("Shift");
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(() => window.getSelection().toString()),
        "t samp",
        `${color}/${mode}: Shift+click`,
      );
      assert.ok(
        !baseline.equals(await page.screenshot({ clip })),
        `${color}/${mode}: Shift+click selection must be visible`,
      );
      if (mode === "edit") {
        await page.keyboard.press("ArrowLeft");
        const keyboardBaseline = await page.screenshot({
          clip: { ...clip, width: 8 },
        });
        await page.keyboard.press("Shift+ArrowRight");
        await page.keyboard.press("Shift+ArrowRight");
        assert.equal(
          await page.evaluate(() => window.getSelection().toString()),
          "t ",
        );
        const keyboard = await page.screenshot({ clip: { ...clip, width: 8 } });
        assert.ok(
          !keyboard.equals(keyboardBaseline),
          `${color}: keyboard selection must be visible`,
        );
        await page.keyboard.type("Z");
        assert.ok(
          (
            await page.evaluate(() => window.editor().state.doc.toString())
          ).startsWith("consZsample"),
        );
      }
      await page.mouse.click(coords[1].right + 40, y);
      await page.mouse.move(coords[0].left, y);
      await page.mouse.down();
      await page.mouse.move(
        coords[2].left,
        (coords[2].top + coords[2].bottom) / 2,
        { steps: 10 },
      );
      await page.mouse.up();
      await page.waitForTimeout(100);
      assert.ok(
        (await page.evaluate(() => window.getSelection().toString())).includes(
          "\n",
        ),
        `${color}/${mode}: multiline selection ${JSON.stringify(await page.evaluate(() => ({ text: window.getSelection().toString(), range: window.editor().state.selection.main.toJSON() })))}`,
      );
      console.log(
        `PASS ${color}/${mode}: visible same-line mouse selection, multiline selection${mode === "edit" ? ", Shift selection and replacement" : ""}`,
      );
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
