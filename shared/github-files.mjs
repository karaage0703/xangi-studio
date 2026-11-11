export async function listPullRequestFiles(json, owner, repo, number) {
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const endpoint = `repos/${owner}/${repo}/pulls/${number}/files?per_page=100${page === 1 ? "" : `&page=${page}`}`;
    const batch = await json(endpoint);
    if (!Array.isArray(batch))
      throw new Error("PRのファイル一覧を取得できませんでした。");
    files.push(...batch);
    if (batch.length < 100) return files;
  }
  throw new Error(
    "GitHub APIの上限（3000ファイル）に達したため、PR全体を取り込めません。",
  );
}
