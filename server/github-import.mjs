import { normalizeReviewContext } from "../shared/review-context.mjs";
import { listPullRequestFiles } from "../shared/github-files.mjs";
import { githubCli as gh } from "./github-cli.mjs";

export function parseGitHubPullRequest(value) {
  const match = String(value ?? "").match(
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/,
  );
  if (!match) {
    const error = new Error("GitHub Pull RequestのURLを指定してください。");
    error.status = 400;
    throw error;
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

const ghJson = async (endpoint) => JSON.parse(await gh(["api", endpoint]));

async function ghRaw(owner, repo, path, ref) {
  try {
    return await gh([
      "api",
      "-X",
      "GET",
      `repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      "-H",
      "Accept: application/vnd.github.raw+json",
    ]);
  } catch {
    return "";
  }
}

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
  const impact = `${kind}に関係する挙動を、コード差分と合わせて確認してください。`;
  return (hunks.length ? hunks : [[null, 0, 0, ""]]).map((match, index) => ({
    heading: match[3]?.trim() || `${kind}の変更 ${index + 1}`,
    summary,
    impact,
    review: "AIレビューは未実施です。画面の「AIレビュー」で実行できます。",
    severity: "info",
    oldStart: Number(match[1]) || 0,
    newStart: Number(match[2]) || 0,
  }));
}

export async function importGitHubPullRequest(
  store,
  url,
  analysis = {},
  github = { json: ghJson, raw: ghRaw },
  reviewContext,
) {
  reviewContext = normalizeReviewContext(reviewContext);
  const { owner, repo, number } = parseGitHubPullRequest(url);
  const pull = await github.json(`repos/${owner}/${repo}/pulls/${number}`);
  const changeSet = {
    kind: "github-pr",
    id: String(number),
    title: pull.title,
    url: pull.html_url,
    source: `${owner}/${repo}`,
    revision: `${pull.base.sha}:${pull.head.sha}`,
  };
  const previous = store.importedRevision(changeSet);
  const current = store
    .list()
    .find(
      (item) =>
        item.changeSet?.kind === changeSet.kind &&
        item.changeSet?.source === changeSet.source &&
        item.changeSet?.id === changeSet.id,
    );
  changeSet.reviewContext =
    reviewContext ?? current?.changeSet.reviewContext ?? "";
  const recordedCount = store
    .list()
    .filter(
      (item) =>
        item.changeSet?.kind === changeSet.kind &&
        item.changeSet?.source === changeSet.source &&
        item.changeSet?.id === changeSet.id &&
        item.changeSet?.revision === changeSet.revision,
    ).length;
  const missingFiles =
    Number.isInteger(pull.changed_files) && recordedCount < pull.changed_files;
  if (
    !Object.keys(analysis).length &&
    !missingFiles &&
    (previous === changeSet.revision || previous === pull.head.sha.slice(0, 12))
  ) {
    if (previous !== changeSet.revision) {
      await store.recordImportedRevision(changeSet);
    }
    const imported = await store.setImportReviewContext(changeSet);
    return {
      changeSet,
      imported,
      skipped: [],
      status: imported.length ? "updated" : "unchanged",
    };
  }
  const files = await listPullRequestFiles(github.json, owner, repo, number);
  const imported = [];
  const skipped = [];
  for (const file of files) {
    if (file.changes > 4000) {
      skipped.push({ file: file.filename, reason: "差分が大きすぎます" });
      continue;
    }
    const beforePath = file.previous_filename ?? file.filename;
    const before =
      file.status === "added"
        ? ""
        : await github.raw(owner, repo, beforePath, pull.base.sha);
    const content =
      file.status === "removed"
        ? ""
        : await github.raw(owner, repo, file.filename, pull.head.sha);
    if (!before && !content && file.status !== "removed") {
      skipped.push({
        file: file.filename,
        reason: "テキストとして取得できません",
      });
      continue;
    }
    try {
      const importedFile = `changes/github/${owner}-${repo}/pr-${number}/${pull.base.sha.slice(0, 12)}-${pull.head.sha.slice(0, 12)}/${file.filename}`;
      const explanations =
        analysis[file.filename] ?? fallbackExplanations(file);
      const existing = await store.updateImported(importedFile, {
        title: pull.title,
        sourceUrl: pull.html_url,
        changeSet,
        explanations,
      });
      if (existing) {
        imported.push(existing);
        continue;
      }
      imported.push(
        await store.create({
          file: importedFile,
          title: pull.title,
          source: "web",
          sourceUrl: pull.html_url,
          before,
          content,
          readOnly: true,
          changeSet,
          explanations,
        }),
      );
    } catch (error) {
      skipped.push({ file: file.filename, reason: error.message });
    }
  }
  if (imported.length && !skipped.length) {
    await store.supersedeImported(changeSet, changeSet.revision);
  }
  return {
    changeSet,
    imported,
    skipped,
    status: previous ? "updated" : "imported",
  };
}

export async function githubDescription(url, github = { json: ghJson }) {
  const { owner, repo, number } = parseGitHubPullRequest(url);
  const pull = await github.json(`repos/${owner}/${repo}/pulls/${number}`);
  return {
    title: String(pull.title ?? ""),
    body: String(pull.body ?? ""),
    url: pull.html_url,
    updatedAt: pull.updated_at,
  };
}
