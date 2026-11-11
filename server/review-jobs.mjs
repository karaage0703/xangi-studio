import { readFile, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { ApiError, atomicWrite, changeSetKey } from "./store.mjs";
import {
  parseAutoReviewResult,
  parseOverviewResponse,
} from "../shared/auto-review.mjs";
import { sourcePath } from "../shared/software-overview.mjs";

// The browser starts the authenticated Web conversation. Collection belongs to
// the extension, so closing that browser cannot discard a completed answer.
export class ReviewJobs {
  constructor(store, transcriptDir, { now = Date.now } = {}) {
    this.store = store;
    this.transcriptDir = resolve(transcriptDir);
    this.file = resolve(store.stateDir, "review-jobs.json");
    this.jobs = [];
    this.now = now;
    this.pending = Promise.resolve();
  }
  exclusive(fn) {
    const next = this.pending.then(fn);
    this.pending = next.catch(() => {});
    return next;
  }
  async init() {
    try {
      this.jobs = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(this.jobs)) throw new Error("Invalid review jobs");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Re-read only failures from the old parser. New failures keep their specific
    // reason and are not retried on every poll or restart. No AI call is made.
    let recovered = false;
    const legacyErrors = new Set([
      "AIレビューの結果を読み取れませんでした。xangi会話で結果を確認してください。",
      "AIレビューにファイル別の結果がありません。xangi会話で結果を確認してください。",
    ]);
    for (const job of this.jobs) {
      if (job.status !== "failed" || !legacyErrors.has(job.error)) continue;
      job.status = "running";
      delete job.error;
      delete job.finishedAt;
      recovered = true;
    }
    if (recovered) await this.persist();
    await this.collect();
    return this;
  }
  list() {
    return this.jobs;
  }
  persist() {
    return atomicWrite(this.file, JSON.stringify(this.jobs));
  }
  register(
    changeSet,
    sessionId,
    reviewer = { id: "xangi-default", name: "xangiのデフォルト" },
    file,
    options = {},
  ) {
    return this.exclusive(async () => {
      if (
        !options ||
        typeof options !== "object" ||
        (options.purpose !== undefined &&
          !["overview", "review"].includes(options.purpose))
      )
        throw new ApiError(400, "処理の種類が正しくありません。");
      const { purpose, group } = options;
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId ?? ""))
        throw new ApiError(400, "会話IDが正しくありません。");
      if (
        !reviewer ||
        typeof reviewer.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(reviewer.id) ||
        typeof reviewer.name !== "string" ||
        !reviewer.name.trim()
      )
        throw new ApiError(400, "レビュワー情報が正しくありません。");
      reviewer = { id: reviewer.id, name: reviewer.name.slice(0, 80) };
      const current = this.store
        .list()
        .find(
          (item) =>
            item.changeSet &&
            ["github-pr", "github-repository", "artifact"].includes(
              item.changeSet?.kind,
            ) &&
            changeSetKey(item.changeSet) === changeSetKey(changeSet) &&
            item.changeSet.revision === changeSet?.revision &&
            item.changeSet.editRevision === changeSet?.editRevision &&
            (purpose === "overview" ||
              (item.changeSet.reviewContext ?? "") ===
                (changeSet?.reviewContext ?? "")),
        );
      if (!current)
        throw new ApiError(
          409,
          "対象の版またはレビュー指示が変わりました。更新を確認してください。",
        );
      const scope = options.files;
      if (
        scope !== undefined &&
        (purpose !== "review" ||
          !Array.isArray(scope) ||
          !scope.length ||
          scope.length > 3000 ||
          new Set(scope).size !== scope.length ||
          scope.some(
            (path) =>
              typeof path !== "string" ||
              !this.store
                .list()
                .some(
                  (item) =>
                    item.file === path &&
                    item.changeSet &&
                    changeSetKey(item.changeSet) ===
                      changeSetKey(current.changeSet) &&
                    item.changeSet.revision === current.changeSet.revision,
                ),
          ))
      )
        throw new ApiError(400, "分割レビューの対象が正しくありません。");
      if (
        purpose === "overview" &&
        (file !== undefined || current.changeSet.kind === "artifact")
      )
        throw new ApiError(
          400,
          "概要はPRまたはリポジトリ全体を指定してください。",
        );
      if (
        file !== undefined &&
        scope !== undefined &&
        (scope.length !== 1 || scope[0] !== file)
      )
        throw new ApiError(400, "ファイルと分割範囲が一致しません。");
      if (
        group !== undefined &&
        (!scope ||
          !Number.isInteger(group?.index) ||
          !Number.isInteger(group?.total) ||
          group.index < 1 ||
          group.index > group.total ||
          group.total > 3)
      )
        throw new ApiError(400, "分割レビューの番号が正しくありません。");
      const files = scope === undefined ? undefined : [...scope].sort();
      if (
        file !== undefined &&
        (typeof file !== "string" ||
          !this.store
            .list()
            .some(
              (item) =>
                item.file === file &&
                item.changeSet &&
                changeSetKey(item.changeSet) ===
                  changeSetKey(current.changeSet) &&
                item.changeSet.revision === current.changeSet.revision,
            ))
      )
        throw new ApiError(400, "レビュー対象のファイルが見つかりません。");
      const existing = this.jobs.find(
        (job) =>
          job.status === "running" &&
          (job.reviewer?.id ?? "xangi-default") === reviewer.id &&
          job.purpose === purpose &&
          JSON.stringify(job.files) === JSON.stringify(files) &&
          job.file === file &&
          changeSetKey(job.changeSet) === changeSetKey(current.changeSet) &&
          job.changeSet.revision === current.changeSet.revision &&
          job.changeSet.editRevision === current.changeSet.editRevision &&
          (purpose === "overview" ||
            (job.changeSet.reviewContext ?? "") ===
              (current.changeSet.reviewContext ?? "")),
      );
      if (existing) return existing;
      if (this.jobs.some((job) => job.sessionId === sessionId))
        throw new ApiError(409, "この会話は既に登録されています。");
      const job = {
        sessionId,
        reviewer,
        file,
        ...(purpose ? { purpose } : {}),
        ...(files ? { files } : {}),
        ...(group ? { group: { index: group.index, total: group.total } } : {}),
        changeSet: current.changeSet,
        status: "running",
        startedAt: this.now(),
      };
      this.jobs.push(job);
      await this.persist();
      return job;
    });
  }
  collect() {
    return this.exclusive(async () => {
      let changed = false;
      for (const job of this.jobs.filter((job) => job.status === "running")) {
        try {
          const path = resolve(this.transcriptDir, `${job.sessionId}.jsonl`);
          let messages = [];
          try {
            // Do not follow a session-file symlink outside the transcript directory.
            const actual = await realpath(path);
            if (dirname(actual) !== (await realpath(this.transcriptDir)))
              throw new Error("会話ログの保存先が正しくありません。");
            const lines = (await readFile(actual, "utf8")).split("\n");
            messages = lines.filter(Boolean).flatMap((line) => {
              try {
                return [JSON.parse(line)];
              } catch {
                return [];
              }
            });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          const user = messages.find((m) => m.role === "user");
          const answer = messages.find((m) => m.role === "assistant");
          if (answer) {
            if (!String(user?.content ?? "").includes(job.changeSet.url))
              throw new Error("会話のレビュー対象が一致しません。");
            const content =
              typeof answer.content === "string"
                ? answer.content
                : answer.content?.result;
            if (job.purpose === "overview") {
              job.result = await this.store.applyImportOverview(
                job.changeSet,
                parseOverviewResponse(content),
                job.reviewer,
              );
            } else {
              const { files: analysis, overview } =
                parseAutoReviewResult(content);
              if (job.files) {
                const expected = job.files.map(sourcePath).sort();
                const actual = Object.keys(analysis).sort();
                if (
                  JSON.stringify(expected) !== JSON.stringify(actual) ||
                  expected.some(
                    (path) =>
                      !Array.isArray(analysis[path]) || !analysis[path].length,
                  )
                )
                  throw new Error(
                    "割り当てた分割範囲だけのレビュー結果ではありません。",
                  );
              }
              if (job.file) {
                const path =
                  /^changes\/github\/[^/]+\/(?:pr-\d+|repo-[a-f0-9]+)\/[^/]+\/(.+)$/.exec(
                    job.file,
                  )?.[1];
                if (
                  !path ||
                  Object.keys(analysis).length !== 1 ||
                  !Object.hasOwn(analysis, path)
                )
                  throw new Error(
                    "指定したファイルだけのレビュー結果ではありません。",
                  );
              }
              job.result = await this.store.applyImportAnalysis(
                job.changeSet,
                analysis,
                job.reviewer,
                job.file || job.purpose === "review" ? undefined : overview,
              );
            }
            job.status = "completed";
            job.finishedAt = this.now();
            changed = true;
          } else if (
            this.now() - job.startedAt >
            (user ? 3_600_000 : 120_000)
          ) {
            throw new Error(
              user
                ? "レビュー結果を時間内に取得できませんでした。会話を確認してください。"
                : "レビュー会話が開始されませんでした。再実行してください。",
            );
          }
        } catch (error) {
          job.status = "failed";
          job.error = error.message;
          job.finishedAt = this.now();
          changed = true;
        }
      }
      if (changed) await this.persist();
    });
  }
  start() {
    this.timer = setInterval(() => {
      void this.collect().catch(console.error);
    }, 2000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }
}
