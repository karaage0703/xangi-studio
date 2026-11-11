import {
  normalizeSoftwareOverview,
  sourcePath,
} from "../shared/software-overview.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  realpath,
  lstat,
  stat,
  open,
} from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, extname } from "node:path";

export const MAX_BYTES = 256 * 1024;
const textExtensions = new Set([
  ".md",
  ".txt",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".jsonl",
  ".css",
  ".yaml",
  ".yml",
  ".py",
  ".sh",
  ".html",
  ".htm",
  ".svg",
]);
const validFileName = (file) => {
  if (
    typeof file !== "string" ||
    !file ||
    isAbsolute(file) ||
    /[\\\0]/.test(file)
  )
    return false;
  const imported = file.startsWith("changes/github/");
  const parts = file.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        (!imported && part.startsWith(".")),
    )
  )
    return false;
  const extension = extname(file).toLowerCase();
  return (
    textExtensions.has(extension) ||
    /^changes\/github\/[^/]+\/repo-[a-f0-9]+\//.test(file) ||
    (imported && !extension) ||
    (imported && parts.at(-1)?.startsWith("."))
  );
};
export const versionOf = (text) =>
  createHash("sha256").update(text).digest("hex");
export const changeSetKey = (changeSet) =>
  changeSet
    ? `${changeSet.kind}:${changeSet.source}:${changeSet.id}`
    : "standalone";
const editableImport = (review) =>
  !review.document &&
  ["workspace", "github-pr", "github-repository"].includes(
    review.changeSet?.kind,
  );
const reviewSeverities = new Set(["info", "warning", "danger"]);
const normalizeExplanation = (item) => ({
  heading: String(item?.heading ?? "変更箇所").slice(0, 120),
  summary: String(item?.summary ?? "").slice(0, 500),
  impact: String(item?.impact ?? "").slice(0, 500),
  review: String(item?.review ?? "").slice(0, 800),
  severity: reviewSeverities.has(item?.severity) ? item.severity : "info",
  oldStart: Number(item?.oldStart) || 0,
  newStart: Number(item?.newStart) || 0,
});
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function atomicWrite(file, content, mode = 0o600) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } finally {
    await handle?.close();
    await unlink(temp).catch(() => {});
  }
}

export class ReviewStore {
  constructor(root, stateDir) {
    this.root = resolve(root);
    this.stateDir = resolve(stateDir);
    this.reviews = [];
    this.preferences = {
      defaultProjectId: null,
      reviewerProjectIds: [],
      archivedChangeSetKeys: [],
    };
    this.pending = Promise.resolve();
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    this.root = await realpath(this.root);
    try {
      this.reviews = JSON.parse(
        await readFile(resolve(this.stateDir, "reviews.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!Array.isArray(this.reviews)) throw new Error("Invalid review state");
    try {
      const preferences = JSON.parse(
        await readFile(resolve(this.stateDir, "preferences.json"), "utf8"),
      );
      if (!preferences || typeof preferences !== "object")
        throw new Error("Invalid review preferences");
      this.preferences = {
        defaultProjectId:
          typeof preferences.defaultProjectId === "string" &&
          preferences.defaultProjectId
            ? preferences.defaultProjectId
            : null,
        reviewerProjectIds: Array.isArray(preferences.reviewerProjectIds)
          ? [
              ...new Set(
                preferences.reviewerProjectIds.filter(
                  (id) => typeof id === "string" && id,
                ),
              ),
            ]
          : [],
        archivedChangeSetKeys: Array.isArray(preferences.archivedChangeSetKeys)
          ? [
              ...new Set(
                preferences.archivedChangeSetKeys.filter(
                  (key) => typeof key === "string" && key,
                ),
              ),
            ]
          : [],
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const seenImports = new Set();
    const deduplicated = [];
    for (const review of [...this.reviews].reverse()) {
      const key = review.changeSet ? review.file : null;
      if (key && seenImports.has(key)) continue;
      if (key) seenImports.add(key);
      deduplicated.push(review);
    }
    deduplicated.reverse();
    // Older imports used readOnly to identify snapshots. Keep their IDs and
    // history, but allow edits to the Studio copy just like new text imports.
    let migrated = false;
    for (const review of deduplicated) {
      if (review.readOnly && editableImport(review)) {
        review.readOnly = false;
        migrated = true;
      }
    }
    if (migrated || deduplicated.length !== this.reviews.length) {
      this.reviews = deduplicated;
      await this.persist();
    }
    return this;
  }

  exclusive(fn) {
    const result = this.pending.then(fn);
    this.pending = result.catch(() => {});
    return result;
  }

  async persist() {
    await atomicWrite(
      resolve(this.stateDir, "reviews.json"),
      JSON.stringify(this.reviews, null, 2),
    );
  }

  async persistPreferences() {
    await atomicWrite(
      resolve(this.stateDir, "preferences.json"),
      JSON.stringify(this.preferences, null, 2),
    );
  }

  async filePath(file) {
    if (!validFileName(file)) {
      throw new ApiError(400, "このファイルは開けません。");
    }
    const target = resolve(this.root, file);
    let actual;
    try {
      actual = await realpath(target);
    } catch (error) {
      if (error.code === "ENOENT")
        throw new ApiError(404, "ファイルが見つかりません。");
      throw error;
    }
    const rel = relative(this.root, actual);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new ApiError(403, "このファイルは開けません。");
    // Disallow symlinks inside the allowed root as well: writes must target the selected file.
    let cursor = this.root;
    for (const part of file.split("/")) {
      cursor = resolve(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink())
        throw new ApiError(403, "リンク先のファイルは編集できません。");
    }
    const info = await stat(target);
    if (!info.isFile()) throw new ApiError(400, "ファイルを指定してください。");
    if (info.size > MAX_BYTES)
      throw new ApiError(413, "ファイルが大きすぎます（上限256KB）。");
    return target;
  }

  async read(file) {
    const path = await this.filePath(file);
    const bytes = await readFile(path);
    if (bytes.length > MAX_BYTES)
      throw new ApiError(413, "ファイルが大きすぎます。");
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ApiError(415, "UTF-8のテキストファイルを指定してください。");
    }
    if (content.includes("\0"))
      throw new ApiError(415, "テキストファイルを指定してください。");
    return {
      content,
      version: versionOf(content),
      size: bytes.length,
      modifiedAt: (await stat(path)).mtime.toISOString(),
    };
  }

  async writeImported(file, content) {
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES)
      throw new ApiError(413, "取り込むファイルが大きすぎます。");
    if (!validFileName(file) || content.includes("\0")) {
      throw new ApiError(400, "このファイルは取り込めません。");
    }
    const target = resolve(this.root, file);
    const rel = relative(this.root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new ApiError(403, "このファイルは取り込めません。");
    await mkdir(dirname(target), { recursive: true });
    await atomicWrite(target, content);
  }

  find(id) {
    const review = this.reviews.find((item) => item.id === id);
    if (!review) throw new ApiError(404, "レビューが見つかりません。");
    return review;
  }

  summary(review) {
    const { before, history, ...rest } = review;
    return { ...rest, history: history.map(({ content, ...item }) => item) };
  }

  list({ includeArchived = false } = {}) {
    const archived = new Set(this.preferences.archivedChangeSetKeys);
    return this.reviews
      .filter(
        (review) =>
          includeArchived ||
          (!review.supersededAt &&
            !archived.has(changeSetKey(review.changeSet))),
      )
      .map((r) => this.summary(r))
      .reverse();
  }

  importedRevision(changeSet) {
    const key = changeSetKey(changeSet);
    const current = this.reviews.findLast(
      (review) =>
        review.changeSet &&
        !review.supersededAt &&
        changeSetKey(review.changeSet) === key,
    );
    if (!current) return null;
    return (
      current.changeSet.revision ??
      current.file.match(/\/([a-f0-9]{12})\//)?.[1] ??
      null
    );
  }

  async recordImportedRevision(changeSet) {
    return this.exclusive(async () => {
      const key = changeSetKey(changeSet);
      let changed = false;
      for (const review of this.reviews) {
        if (
          review.changeSet &&
          !review.supersededAt &&
          changeSetKey(review.changeSet) === key &&
          !review.changeSet.revision
        ) {
          review.changeSet = {
            ...review.changeSet,
            revision: changeSet.revision,
          };
          changed = true;
        }
      }
      if (changed) await this.persist();
    });
  }

  async setImportReviewContext(changeSet) {
    return this.exclusive(async () => {
      const updated = [];
      for (const review of this.reviews) {
        if (
          review.changeSet &&
          !review.supersededAt &&
          changeSetKey(review.changeSet) === changeSetKey(changeSet) &&
          review.changeSet.revision === changeSet.revision &&
          (review.changeSet.reviewContext ?? "") !==
            (changeSet.reviewContext ?? "")
        ) {
          review.changeSet = {
            ...review.changeSet,
            reviewContext: changeSet.reviewContext ?? "",
          };
          review.explanations = [];
          review.reviewerResults = {};
          updated.push({ id: review.id });
        }
      }
      if (updated.length) await this.persist();
      return updated;
    });
  }

  async applyImportOverview(changeSet, overview, reviewer) {
    return this.exclusive(async () => {
      const candidates = this.reviews.filter(
        (review) =>
          review.changeSet &&
          !review.supersededAt &&
          ["github-pr", "github-repository"].includes(review.changeSet?.kind) &&
          changeSetKey(review.changeSet) === changeSetKey(changeSet) &&
          review.changeSet.revision === changeSet?.revision &&
          review.changeSet.editRevision === changeSet?.editRevision,
      );
      if (!changeSet?.revision || !candidates.length)
        throw new ApiError(
          409,
          "概要の対象版が変わりました。更新を確認してください。",
        );
      const normalized = normalizeSoftwareOverview(
        overview,
        candidates.map((r) => sourcePath(r.file)),
      );
      if (!normalized) throw new ApiError(400, "全体概要がありません。");
      candidates[0].softwareOverview = {
        ...normalized,
        revision: changeSet.revision,
        generatedAt: new Date().toISOString(),
        reviewer: reviewer?.name ?? "AI",
      };
      await this.persist();
      return { updated: 1, total: 1 };
    });
  }

  async applyImportAnalysis(changeSet, analysis, reviewer, overview) {
    if (
      !changeSet ||
      !["github-pr", "github-repository", "artifact"].includes(
        changeSet.kind,
      ) ||
      typeof changeSet.revision !== "string" ||
      !analysis ||
      typeof analysis !== "object" ||
      Array.isArray(analysis) ||
      Object.keys(analysis).length > 3000
    )
      throw new ApiError(400, "レビュー結果が正しくありません。");
    return this.exclusive(async () => {
      const candidates = this.reviews.filter(
        (review) =>
          review.changeSet &&
          !review.supersededAt &&
          changeSetKey(review.changeSet) === changeSetKey(changeSet) &&
          review.changeSet.revision === changeSet.revision &&
          review.changeSet.editRevision === changeSet.editRevision &&
          (review.changeSet.reviewContext ?? "") ===
            (changeSet.reviewContext ?? ""),
      );
      if (!candidates.length)
        throw new ApiError(
          409,
          "対象の版またはレビュー指示が変わりました。更新を確認してください。",
        );
      const normalizedOverview = normalizeSoftwareOverview(
        overview,
        candidates.map((r) => sourcePath(r.file)),
      );
      const updates = [];
      for (const [path, entries] of Object.entries(analysis)) {
        if (
          typeof path !== "string" ||
          !Array.isArray(entries) ||
          entries.length > 6
        )
          throw new ApiError(400, "レビュー結果が正しくありません。");
        const review = candidates.find(
          (item) =>
            /^changes\/github\/[^/]+\/(?:pr-\d+|repo-[a-f0-9]+)\/[^/]+\/(.+)$/.exec(
              item.file,
            )?.[1] === path ||
            (item.document && item.file === path),
        );
        if (!review || !entries.length) continue;
        updates.push({
          review,
          explanations: entries.map(normalizeExplanation),
        });
      }
      if (!updates.length)
        throw new ApiError(
          400,
          "取り込み済みファイルに対応するレビューがありません。",
        );
      if (changeSet.kind === "artifact" && updates.length !== candidates.length)
        throw new ApiError(
          400,
          "一部ページのレビューがありません。全ページの結果を返してください。",
        );
      if (normalizedOverview) {
        candidates[0].softwareOverview = {
          ...normalizedOverview,
          revision: changeSet.revision,
          generatedAt: new Date().toISOString(),
          reviewer: reviewer?.name ?? "AI",
        };
      }
      for (const { review, explanations } of updates) {
        if (reviewer) {
          review.reviewerResults ??= {};
          review.reviewerResults = {
            ...review.reviewerResults,
            [reviewer.id]: { reviewer, explanations },
          };
          review.explanations = Object.values(review.reviewerResults)
            .sort((a, b) => a.reviewer.id.localeCompare(b.reviewer.id))
            .flatMap((result) =>
              result.explanations.map((item) => ({
                ...item,
                heading: `[${result.reviewer.name}] ${item.heading}`,
              })),
            );
        } else {
          review.explanations = explanations;
        }
      }
      await this.persist();
      return { updated: updates.length, total: candidates.length };
    });
  }

  async supersedeImported(changeSet, revision) {
    return this.exclusive(async () => {
      const key = changeSetKey(changeSet);
      const now = new Date().toISOString();
      let changed = false;
      for (const review of this.reviews) {
        if (
          review.changeSet &&
          !review.supersededAt &&
          changeSetKey(review.changeSet) === key &&
          review.changeSet.revision !== revision
        ) {
          review.supersededAt = now;
          changed = true;
        }
      }
      if (changed) await this.persist();
    });
  }

  reviewPreferences() {
    const archived = new Set(this.preferences.archivedChangeSetKeys);
    const archivedChangeSets = [];
    const seen = new Set();
    for (const review of [...this.reviews].reverse()) {
      const key = changeSetKey(review.changeSet);
      if (!review.changeSet || !archived.has(key) || seen.has(key)) continue;
      seen.add(key);
      archivedChangeSets.push({ key, ...review.changeSet });
    }
    return {
      defaultProjectId: this.preferences.defaultProjectId,
      reviewerProjectIds: [...this.preferences.reviewerProjectIds],
      archivedChangeSets,
    };
  }

  async updateReviewPreferences({ defaultProjectId, reviewerProjectIds }) {
    if (defaultProjectId !== null && typeof defaultProjectId !== "string")
      throw new ApiError(400, "レビュワー設定が正しくありません。");
    if (!Array.isArray(reviewerProjectIds))
      throw new ApiError(400, "追加レビュー設定が正しくありません。");
    const additional = [
      ...new Set(
        reviewerProjectIds.map((id) => String(id).trim()).filter(Boolean),
      ),
    ].filter((id) => id !== defaultProjectId?.trim());
    this.preferences.defaultProjectId = defaultProjectId?.trim() || null;
    this.preferences.reviewerProjectIds = additional;
    await this.persistPreferences();
    return this.reviewPreferences();
  }

  async setChangeSetArchived(key, archived) {
    if (typeof key !== "string" || !key.trim() || key === "standalone")
      throw new ApiError(400, "変更セットが正しくありません。");
    const normalized = key.trim();
    if (
      !this.reviews.some(
        (review) => changeSetKey(review.changeSet) === normalized,
      )
    )
      throw new ApiError(404, "変更セットが見つかりません。");
    const keys = new Set(this.preferences.archivedChangeSetKeys);
    if (archived) keys.add(normalized);
    else keys.delete(normalized);
    this.preferences.archivedChangeSetKeys = [...keys];
    await this.persistPreferences();
    return this.reviewPreferences();
  }

  async get(id) {
    const review = this.find(id);
    return {
      ...this.summary(review),
      before: review.before,
      ...(await this.read(review.file)),
    };
  }

  async createDocumentPages(entries) {
    return this.exclusive(async () => {
      const records = [];
      for (const entry of entries) {
        await this.writeImported(entry.file, entry.content);
        records.push({
          ...entry,
          content: undefined,
          id: randomUUID(),
          source: "web",
          sourceUrl: entry.sourceUrl ?? null,
          before: entry.content,
          createdAt: new Date().toISOString(),
          history: [],
          explanations: entry.explanations.map(normalizeExplanation),
        });
      }
      this.reviews.push(...records);
      try {
        await this.persist();
      } catch (error) {
        this.reviews.splice(-records.length);
        throw error;
      }
      return records;
    });
  }

  async create({
    file,
    title,
    source = "web",
    sourceUrl,
    before,
    content,
    id,
    readOnly = false,
    changeSet = null,
    explanations = [],
  }) {
    return this.exclusive(async () => {
      if (content !== undefined) await this.writeImported(file, content);
      const current = await this.read(file);
      if (!["discord", "slack", "web"].includes(source))
        throw new ApiError(400, "送信元が正しくありません。");
      if (sourceUrl) {
        let url;
        try {
          url = new URL(sourceUrl);
        } catch {
          throw new ApiError(400, "会話URLが正しくありません。");
        }
        if (url.protocol !== "https:")
          throw new ApiError(400, "会話URLはHTTPSを指定してください。");
      }
      if (
        before !== undefined &&
        (typeof before !== "string" || Buffer.byteLength(before) > MAX_BYTES)
      )
        throw new ApiError(400, "比較元の内容が正しくありません。");
      const baseline = before ?? current.content;
      const now = new Date().toISOString();
      const importedPeer =
        changeSet &&
        this.reviews.findLast(
          (item) =>
            changeSetKey(item.changeSet) === changeSetKey(changeSet) &&
            item.changeSet?.revision === changeSet.revision,
        );
      const review = {
        id: id ?? randomUUID(),
        file,
        title: typeof title === "string" ? title.slice(0, 160) : file,
        source,
        sourceUrl: sourceUrl || null,
        readOnly: editableImport({ changeSet }) ? false : Boolean(readOnly),
        changeSet:
          changeSet && typeof changeSet === "object"
            ? {
                ...changeSet,
                ...(importedPeer?.changeSet.editRevision
                  ? { editRevision: importedPeer.changeSet.editRevision }
                  : {}),
              }
            : null,
        explanations: Array.isArray(explanations)
          ? explanations.slice(0, 100).map(normalizeExplanation)
          : [],
        createdAt: now,
        before: baseline,
        history: [
          { id: randomUUID(), label: "AI作業前", at: now, content: baseline },
        ],
      };
      this.reviews.push(review);
      try {
        await this.persist();
      } catch (error) {
        this.reviews.pop();
        throw error;
      }
      return this.get(review.id);
    });
  }

  async updateImported(file, { title, sourceUrl, changeSet, explanations }) {
    return this.exclusive(async () => {
      const review = this.reviews.find(
        (item) => item.file === file && item.changeSet,
      );
      if (!review) return null;
      review.title = typeof title === "string" ? title.slice(0, 160) : file;
      review.sourceUrl = sourceUrl || null;
      if (
        (review.changeSet.reviewContext ?? "") !==
        (changeSet.reviewContext ?? "")
      ) {
        review.reviewerResults = {};
        delete review.softwareOverview;
      }
      review.changeSet = {
        ...changeSet,
        ...(review.changeSet.editRevision
          ? { editRevision: review.changeSet.editRevision }
          : {}),
      };
      if (!review.changeSet.editRevision)
        review.explanations = Array.isArray(explanations)
          ? explanations.slice(0, 100).map(normalizeExplanation)
          : [];
      await this.persist();
      return this.get(review.id);
    });
  }

  // Remove only the Studio record. The source file may be shared or an original.
  async remove(id) {
    return this.exclusive(async () => {
      const index = this.reviews.findIndex((review) => review.id === id);
      if (index < 0) throw new ApiError(404, "成果物が見つかりません。");
      const [review] = this.reviews.splice(index, 1);
      try {
        await this.persist();
      } catch (error) {
        this.reviews.splice(index, 0, review);
        throw error;
      }
      return { id: review.id, file: review.file, deleted: true };
    });
  }

  async save(id, content) {
    return this.exclusive(async () => {
      if (typeof content !== "string")
        throw new ApiError(400, "保存する本文が必要です。");
      if (Buffer.byteLength(content) > MAX_BYTES)
        throw new ApiError(413, "ファイルが大きすぎます。");
      const review = this.find(id);
      if (review.readOnly)
        throw new ApiError(403, "このファイルは閲覧専用です。");
      const current = await this.read(review.file);
      const path = await this.filePath(review.file);
      const next = current.content.includes("\r\n")
        ? content.replace(/\r?\n/g, "\r\n")
        : content;
      if (Buffer.byteLength(next) > MAX_BYTES)
        throw new ApiError(413, "ファイルが大きすぎます。");
      if (next !== current.content) {
        const oldHistory = review.history;
        review.history = [
          oldHistory[0],
          ...oldHistory.slice(1),
          {
            id: randomUUID(),
            label: "保存前の内容",
            at: new Date().toISOString(),
            content: current.content,
          },
        ];
        if (review.history.length > 21)
          review.history.splice(1, review.history.length - 21);
        // A saved edit invalidates review output for the imported snapshot.
        // Keep its upstream revision for refresh/deduplication, and use a
        // separate token to reject results from conversations started earlier.
        if (review.changeSet) {
          const editRevision = randomUUID();
          for (const item of this.reviews) {
            if (
              changeSetKey(item.changeSet) === changeSetKey(review.changeSet) &&
              item.changeSet?.revision === review.changeSet.revision
            ) {
              item.changeSet = { ...item.changeSet, editRevision };
              item.explanations = [];
              item.reviewerResults = {};
              delete item.softwareOverview;
            }
          }
        }
        // Persist a recovery copy before replacing the file.
        try {
          await this.persist();
        } catch (error) {
          review.history = oldHistory;
          throw error;
        }
        await atomicWrite(path, next, (await stat(path)).mode & 0o777);
      }
      return this.get(id);
    });
  }

  snapshot(id, snapshotId) {
    const snapshot = this.find(id).history.find(
      (item) => item.id === snapshotId,
    );
    if (!snapshot) throw new ApiError(404, "保存履歴が見つかりません。");
    return snapshot;
  }
}

export async function seedDemo(store) {
  const samples = [
    {
      id: "demo-markdown",
      file: "drafts/小さな道具をつくる.md",
      source: "discord",
      title: "ブログの導入と構成を整える",
      before:
        "# 小さな道具をつくる\n\nAIに頼むと、ファイルがすぐにできる。\nでも、できあがったものを確認するのは少し面倒だ。\n\n## ほしいもの\n\n- ファイルを見る\n- 変更した場所を知る\n- 少しだけ直す\n\n## 次にやること\n\nまずはPCで使える画面をつくる。\n",
      after:
        "# 小さな道具をつくる\n\nAIに頼むと、ファイルがすぐにできる。\nだからこそ、できあがったものを気軽に確かめられる道具がほしい。\n\n散歩の途中でも、机に戻ってからでも。\n会話のリンクを開いて、そのまま読んで、気になる一文を直せるといい。\n\n## ほしいもの\n\n- ファイルを読みやすく表示する\n- AIが変更した場所を、作業前と比べる\n- 気になる箇所だけ直して保存する\n\n> 書くことと、確かめること。その間を短くしたい。\n\n## 次にやること\n\nPCとスマホで同じファイルを開き、微修正まで試してみる。\n\nここは体験用の原稿です。好きな一文を書き足して保存できます。\n",
    },
    {
      id: "demo-code",
      file: "src/greeting.ts",
      source: "slack",
      title: "名前が空のときの挨拶を修正",
      before:
        "export function greeting(name: string): string {\n  return `こんにちは、${name}さん。`;\n}\n",
      after:
        'export function greeting(name: string): string {\n  const displayName = name.trim();\n\n  if (!displayName) {\n    return "こんにちは。";\n  }\n\n  return `こんにちは、${displayName}さん。`;\n}\n',
    },
    {
      id: "demo-json",
      file: "config/editor.json",
      source: "web",
      title: "表示と保存の設定を確認",
      before:
        '{\n  "theme": "light",\n  "fontSize": 14,\n  "wrapLines": false\n}\n',
      after:
        '{\n  "theme": "light",\n  "fontSize": 16,\n  "wrapLines": true,\n  "saveShortcut": true\n}\n',
    },
  ];
  for (const sample of samples) {
    if (store.reviews.some((r) => r.id === sample.id)) continue;
    const path = resolve(store.root, sample.file);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, sample.after, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await store.create(sample);
  }
}
