import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { reviewUrl, formatLink } from "../shared/links.mjs";

const [command, target, ...args] = process.argv.slice(2);
if (
  !["begin", "link", "list"].includes(command) ||
  (command !== "list" && !target)
) {
  console.log(
    `xangi editor 連携用CLI\n\n  npm run review -- begin <相対ファイルパス> [--title <説明>] [--source discord|slack|web] [--source-url <会話URL>]\n  npm run review -- link <review-id> [--mode preview|diff|edit]\n  npm run review -- list\n\nbeginはAIがファイルを変更する前に実行します。変更後も同じリンクで差分を確認できます。\nEDITOR_ROOTで対象フォルダを指定し、EDITOR_STATE_DIRで状態の保存先を切り替えます。`,
  );
  process.exit(command ? 1 : 0);
}
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const project = fileURLToPath(new URL("..", import.meta.url));
const stateDir = resolve(project, process.env.EDITOR_STATE_DIR ?? ".state");
try {
  const runtime = JSON.parse(
    await readFile(resolve(stateDir, "runtime.json"), "utf8"),
  );
  const key = (
    await readFile(resolve(stateDir, "access-token"), "utf8")
  ).trim();
  const baseUrl = process.env.EDITOR_BASE_URL ?? runtime.baseUrl;
  const api = async (path, options = {}) => {
    const response = await fetch(new URL(path, baseUrl), {
      ...options,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  };
  if (command === "list") {
    console.log(JSON.stringify(await api("/api/reviews"), null, 2));
  } else {
    const mode = option("--mode", command === "begin" ? "diff" : "preview");
    if (!["preview", "diff", "edit"].includes(mode))
      throw new Error("modeはpreview/diff/editを指定してください。");
    const review =
      command === "begin"
        ? await api("/api/reviews", {
            method: "POST",
            body: JSON.stringify({
              file: target,
              title: option("--title", target),
              source: option("--source", "web"),
              sourceUrl: option("--source-url", undefined),
              before: args.includes("--new") ? "" : undefined,
            }),
          })
        : await api(`/api/reviews/${encodeURIComponent(target)}`);
    const url = reviewUrl(baseUrl, review.id, key, mode);
    console.log(
      JSON.stringify(
        {
          id: review.id,
          file: review.file,
          url,
          discord: formatLink(url, `${review.file}を開く`, "discord"),
          slack: formatLink(url, `${review.file}を開く`, "slack"),
          web: url,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
