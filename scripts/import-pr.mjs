import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { reviewUrl } from "../shared/links.mjs";
import { listPullRequestFiles } from "../shared/github-files.mjs";

const [target, ...args] = process.argv.slice(2);
const matched = target?.match(
  /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/pull\/|#)(\d+)\/?$/,
);
if (!matched) {
  console.error(
    "使い方: npm run import-pr -- https://github.com/owner/repo/pull/123 [--analysis explanations.json]",
  );
  process.exit(1);
}
const [, owner, repo, numberText] = matched;
const number = Number(numberText);
const project = fileURLToPath(new URL("..", import.meta.url));
const stateDir = resolve(project, process.env.EDITOR_STATE_DIR ?? ".state");
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const ghJson = (endpoint) =>
  JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8" }));
const ghRaw = (path, ref) => {
  try {
    return execFileSync(
      "gh",
      [
        "api",
        "-X",
        "GET",
        `repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
        "-H",
        "Accept: application/vnd.github.raw+json",
      ],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
  } catch {
    return "";
  }
};

function fallbackExplanations(file) {
  const patch = file.patch ?? "";
  const hunks = [
    ...patch.matchAll(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s*(.*)$/gm),
  ];
  const kind = /(^|\/)(test|tests|__tests__)(\/|\.)|\.test\.|\.spec\./i.test(
    file.filename,
  )
    ? "テスト"
    : /(^|\/)(config|settings)|\.(json|ya?ml)$/i.test(file.filename)
      ? "設定"
      : /\.(md|txt)$/i.test(file.filename)
        ? "ドキュメント"
        : "処理";
  const summary = `${kind}を更新しています（追加${file.additions}行、削除${file.deletions}行）。`;
  const impact =
    kind === "テスト"
      ? "期待する挙動と回帰条件が変わります。"
      : kind === "設定"
        ? "実行時の設定や初期値に影響する可能性があります。"
        : kind === "ドキュメント"
          ? "利用者向けの説明が変わります。"
          : "このファイルを利用する処理の挙動に影響します。";
  if (!hunks.length)
    return [
      {
        heading: `${kind}の変更`,
        summary,
        impact,
        review: "AIレビューは未実施です。分析JSONを指定してください。",
        severity: "info",
        oldStart: 0,
        newStart: 0,
      },
    ];
  return hunks.map((match, index) => ({
    heading: match[3]?.trim() || `${kind}の変更 ${index + 1}`,
    summary,
    impact,
    review: "AIレビューは未実施です。分析JSONを指定してください。",
    severity: "info",
    oldStart: Number(match[1]),
    newStart: Number(match[2]),
  }));
}

try {
  const runtime = JSON.parse(
    await readFile(resolve(stateDir, "runtime.json"), "utf8"),
  );
  const key = (
    await readFile(resolve(stateDir, "access-token"), "utf8")
  ).trim();
  const baseUrl = process.env.EDITOR_BASE_URL ?? runtime.baseUrl;
  const pull = ghJson(`repos/${owner}/${repo}/pulls/${number}`);
  const files = await listPullRequestFiles(ghJson, owner, repo, number);
  const analysisPath = option("--analysis");
  const analysis = analysisPath
    ? JSON.parse(await readFile(resolve(analysisPath), "utf8"))
    : {};
  const imported = [];
  const skipped = [];
  for (const file of files) {
    if (file.changes > 4000) {
      skipped.push({ file: file.filename, reason: "差分が大きすぎます" });
      continue;
    }
    const beforePath = file.previous_filename ?? file.filename;
    const before =
      file.status === "added" ? "" : ghRaw(beforePath, pull.base.sha);
    const content =
      file.status === "removed" ? "" : ghRaw(file.filename, pull.head.sha);
    if (!before && !content && file.status !== "removed") {
      skipped.push({
        file: file.filename,
        reason: "テキストとして取得できません",
      });
      continue;
    }
    const body = {
      file: `pulls/${owner}-${repo}/pr-${number}/${file.filename}`,
      title: pull.title,
      source: "web",
      sourceUrl: pull.html_url,
      before,
      content,
      readOnly: true,
      changeSet: {
        kind: "github-pr",
        id: String(number),
        title: pull.title,
        url: pull.html_url,
        source: `${owner}/${repo}`,
      },
      explanations: analysis[file.filename] ?? fallbackExplanations(file),
    };
    const response = await fetch(new URL("/api/reviews", baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const review = await response.json();
    if (!response.ok) {
      skipped.push({ file: file.filename, reason: review.error });
      continue;
    }
    imported.push({
      file: file.filename,
      id: review.id,
      url: reviewUrl(baseUrl, review.id, key, "diff"),
    });
  }
  console.log(
    JSON.stringify(
      {
        pullRequest: pull.html_url,
        title: pull.title,
        imported,
        skipped,
        firstUrl: imported[0]?.url ?? null,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
