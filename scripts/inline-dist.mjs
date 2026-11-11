import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(projectRoot, "dist");
const indexPath = resolve(distDir, "index.html");
let html = await readFile(indexPath, "utf8");

const stylesheet = html.match(
  /<link\s+rel="stylesheet"[^>]+href="\.\/(assets\/[^"]+\.css)"[^>]*>/,
);
const moduleScript = html.match(
  /<script\s+type="module"[^>]+src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/,
);

if (!stylesheet || !moduleScript) {
  throw new Error(
    "ViteのCSSまたはJavaScript assetをindex.htmlから検出できません。",
  );
}

const [css, javascript] = await Promise.all([
  readFile(resolve(distDir, stylesheet[1]), "utf8"),
  readFile(resolve(distDir, moduleScript[1]), "utf8"),
]);

html = html
  .replace(stylesheet[0], () => `<style>${css}</style>`)
  .replace(
    moduleScript[0],
    () =>
      `<script type="module">${javascript.replaceAll("</script", "<\\/script")}</script>`,
  );

await writeFile(indexPath, html);
console.log("Inlined Vite assets for the xangi Extension CSP.");
