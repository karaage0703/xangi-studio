import { githubCli } from "./github-cli.mjs";
import { createHash } from "node:crypto";
import { MAX_BYTES, ApiError } from "./store.mjs";
import { normalizeReviewContext } from "../shared/review-context.mjs";
const json = async (endpoint) =>
  JSON.parse(await githubCli(["api", endpoint], 24 * 1024 * 1024));
export function parseGitHubRepository(value) {
  const match =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/(.+?))?\/?$/.exec(
      String(value ?? ""),
    );
  if (!match || [match[1], match[2]].some((s) => s === "." || s === ".."))
    throw new ApiError(
      400,
      "GitHubのPRまたはリポジトリURLを指定してください。",
    );
  let ref;
  try {
    ref = match[3] ? decodeURIComponent(match[3]) : undefined;
  } catch {
    throw new ApiError(400, "ブランチ名を読み取れません。");
  }
  if (ref && /[?#\x00-\x1f]/.test(ref))
    throw new ApiError(400, "ブランチ名が正しくありません。");
  return { owner: match[1], repo: match[2], ref };
}
export async function importGitHubRepository(
  store,
  url,
  analysis = {},
  github = { json },
  reviewContext,
) {
  const { owner, repo, ref } = parseGitHubRepository(url);
  const source = `${owner}/${repo}`;
  const metadata = await github.json(`repos/${source}`);
  const branch = ref ?? metadata.default_branch;
  const commit = await github.json(
    `repos/${source}/commits/${encodeURIComponent(branch)}`,
  );
  if (!/^[a-f0-9]{40,64}$/.test(commit.sha))
    throw new Error("コミットを特定できません。");
  const changeSet = {
    kind: "github-repository",
    id: branch,
    source,
    title: `${source} (${branch})`,
    url: `https://github.com/${source}${ref ? `/tree/${encodeURIComponent(ref)}` : ""}`,
    revision: commit.sha,
  };
  const current = store
    .list()
    .filter(
      (item) =>
        item.changeSet?.kind === changeSet.kind &&
        item.changeSet.source === source &&
        item.changeSet.id === branch,
    );
  changeSet.reviewContext =
    normalizeReviewContext(reviewContext) ??
    current[0]?.changeSet.reviewContext ??
    "";
  const tree = await github.json(
    `repos/${source}/git/trees/${commit.sha}?recursive=1`,
  );
  if (tree.truncated)
    throw new ApiError(
      413,
      "GitHubのファイル一覧が省略されています。完全な一覧を取得できないため取り込みを中止しました。",
    );
  const entries = tree.tree.filter((entry) => entry.type !== "tree");
  if (entries.length > 3000)
    throw new ApiError(413, "リポジトリは3,000ファイルまで取り込めます。");
  const imported = [],
    skipped = [];
  const branchKey = createHash("sha256")
    .update(`${source}:${branch}`)
    .digest("hex")
    .slice(0, 20);
  let total = 0;
  let changed = false;
  for (const entry of entries) {
    try {
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw new Error("シンボリックリンク・サブモジュールは対象外です");
      if (entry.size > MAX_BYTES)
        throw new Error("ファイルが大きすぎます（上限256KB）");
      total += entry.size ?? 0;
      if (total > 20 * 1024 * 1024)
        throw new Error("取り込み合計20MBの上限を超えています");
      const file = `changes/github/${owner}-${repo}/repo-${branchKey}/${commit.sha}/${entry.path}`;
      const existing = current.find((item) => item.file === file);
      if (existing && !analysis[entry.path]) {
        imported.push(existing);
        continue;
      }
      const blob = await github.json(`repos/${source}/git/blobs/${entry.sha}`);
      if (blob.encoding !== "base64")
        throw new Error("テキストとして取得できません");
      const bytes = Buffer.from(blob.content, "base64");
      if (bytes.length > MAX_BYTES)
        throw new Error("ファイルが大きすぎます（上限256KB）");
      let content;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("UTF-8テキストではありません（バイナリ等）");
      }
      if (content.includes("\0"))
        throw new Error("バイナリファイルは対象外です");
      const explanations = analysis[entry.path] ?? [
        {
          heading: "ファイルの内容",
          summary:
            "指定コミットのファイル全体です。PRの追加差分ではありません。",
          impact: "",
          review: "AIレビューは未実施です。",
          severity: "info",
          oldStart: 0,
          newStart: 1,
        },
      ];
      const updated =
        existing &&
        (await store.updateImported(file, {
          title: changeSet.title,
          sourceUrl: changeSet.url,
          changeSet,
          explanations,
        }));
      imported.push(
        updated ||
          (await store.create({
            file,
            title: changeSet.title,
            source: "web",
            sourceUrl: changeSet.url,
            before: "",
            content,
            readOnly: true,
            changeSet,
            explanations,
          })),
      );
      changed = true;
    } catch (error) {
      skipped.push({ file: entry.path, reason: error.message });
    }
  }
  const contextUpdates = await store.setImportReviewContext(changeSet);
  changed ||= contextUpdates.length > 0;
  // Incomplete snapshots must not hide the last complete revision.
  if (imported.length && !skipped.length)
    await store.supersedeImported(changeSet, changeSet.revision);
  return {
    changeSet,
    imported,
    skipped,
    status:
      changed || skipped.length
        ? current.length
          ? "updated"
          : "imported"
        : "unchanged",
  };
}
