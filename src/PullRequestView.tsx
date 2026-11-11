import { SoftwareOverview } from "./SoftwareOverview";
import { type ReactNode, Fragment, useEffect, useRef, useState } from "react";
import type { Explanation, Review, ReviewJob, ReviewSummary } from "./api";
import { reviewApi } from "./api";
import { RepositoryFiles } from "./RepositoryFiles";
import { PullRequestDescription } from "./PullRequestDescription";
import { buildPullRequestRows } from "../shared/pull-request-rows.mjs";
import { reviewJobKey } from "../shared/review-plan.mjs";

type Row = {
  kind: "context" | "added" | "removed" | "omitted";
  oldLine?: number;
  newLine?: number;
  text?: string;
  count?: number;
  comments: number[];
};

const displayPath = (file: string) =>
  file.replace(
    /^changes\/github\/[^/]+\/(?:pr-\d+|repo-[a-f0-9]+)\/[^/]+\//,
    "",
  );

function InlineComment({ item, index }: { item: Explanation; index: number }) {
  return (
    <aside
      className={`pr-inline-comment severity-${item.severity}`}
      aria-label={`変更${index + 1}の説明とレビュー`}
    >
      <div className="pr-inline-comment-heading">
        <strong>{item.heading}</strong>
        {item.severity !== "info" && (
          <span>{item.severity === "danger" ? "危険" : "要注意"}</span>
        )}
      </div>
      <p>
        <b>説明</b> {item.summary}
      </p>
      {item.impact && (
        <p>
          <b>影響</b> {item.impact}
        </p>
      )}
      {item.review && (
        <p className="pr-inline-review">
          <b>レビュー</b> {item.review}
        </p>
      )}
    </aside>
  );
}

function PullRequestFile({
  item,
  onOpenFile,
  onReviewFile,
}: {
  item: ReviewSummary;
  onOpenFile: (id: string) => void;
  onReviewFile: (item: ReviewSummary) => void;
}) {
  const target = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    void reviewApi.read(item.id).then(
      (value) => {
        if (active) {
          setReview(value);
          setError("");
        }
      },
      (cause: Error) => {
        if (active) setError(cause.message);
      },
    );
    return () => {
      active = false;
    };
  }, [item, visible]);
  const rows = review
    ? (buildPullRequestRows(
        review.before,
        review.content,
        review.explanations ?? [],
      ) as Row[])
    : [];
  return (
    <section
      ref={target}
      id={`pr-file-${item.id}`}
      className="pr-file-card"
      aria-label={displayPath(item.file)}
    >
      <header className="pr-file-heading">
        <strong>{displayPath(item.file)}</strong>
        <div>
          <button onClick={() => onReviewFile(item)}>
            このファイルをレビュー
          </button>
          <button onClick={() => onOpenFile(item.id)}>個別表示</button>
        </div>
      </header>
      {error ? (
        <p className="pr-file-state" role="alert">
          読み込みに失敗しました: {error}
        </p>
      ) : !review ? (
        <p className="pr-file-state" role="status">
          差分を読み込み中…
        </p>
      ) : rows.length === 0 ? (
        <p className="pr-file-state">差分はありません。</p>
      ) : (
        <div
          className="pr-diff-scroll"
          tabIndex={0}
          aria-label={`${displayPath(item.file)}の差分`}
        >
          <div className="pr-diff-lines">
            {rows.map((row, rowIndex) => (
              <Fragment key={`${item.id}-${rowIndex}`}>
                {row.comments.map(
                  (index) =>
                    review.explanations?.[index] && (
                      <InlineComment
                        key={`${item.id}-comment-${index}`}
                        item={review.explanations[index]}
                        index={index}
                      />
                    ),
                )}
                {row.kind === "omitted" ? (
                  <div className="pr-diff-omitted">
                    変更のない{row.count}行を省略
                  </div>
                ) : (
                  <div className={`pr-diff-line ${row.kind}`}>
                    <span className="pr-diff-number">{row.oldLine ?? ""}</span>
                    <span className="pr-diff-number">{row.newLine ?? ""}</span>
                    <span className="pr-diff-marker" aria-hidden="true">
                      {row.kind === "added"
                        ? "+"
                        : row.kind === "removed"
                          ? "−"
                          : " "}
                    </span>
                    <code>{row.text || " "}</code>
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function PullRequestView({
  items,
  jobs,
  onOpenFile,
  onReviewFile,
  onReviewAll,
  onGenerateOverview,
  onBackFiles,
  exportAction,
}: {
  items: ReviewSummary[];
  jobs: ReviewJob[];
  onOpenFile: (id: string) => void;
  onReviewFile: (item: ReviewSummary) => void;
  onReviewAll: () => void;
  onGenerateOverview: () => void;
  onBackFiles: () => void;
  exportAction?: ReactNode;
}) {
  const [view, setView] = useState("files");
  const first = items[0];
  if (!first?.changeSet) return null;
  const currentJobs = Array.from(
    new Map(
      jobs
        .filter(
          (job) =>
            job.changeSet.kind === first.changeSet?.kind &&
            job.changeSet.source === first.changeSet?.source &&
            job.changeSet.id === first.changeSet?.id &&
            job.changeSet.revision === first.changeSet?.revision &&
            job.changeSet.editRevision === first.changeSet?.editRevision,
        )
        .filter(
          (job) =>
            job.purpose === "overview" ||
            (job.changeSet.reviewContext ?? "") ===
              (first.changeSet?.reviewContext ?? ""),
        )
        .map((job) => [reviewJobKey(job), job]),
    ).values(),
  );
  const runningOverview = currentJobs.some(
    (job) => job.purpose === "overview" && job.status === "running",
  );
  const running = currentJobs.filter(
    (job) => job.status === "running" && job.purpose !== "overview",
  ).length;
  const failed = currentJobs.filter((job) => job.status === "failed");
  return (
    <div
      className={`pr-overview ${first.changeSet.kind === "github-repository" ? "repository-overview" : ""}`}
    >
      <header className="pr-overview-heading">
        {first.changeSet.kind !== "github-repository" && (
          <>
            <button className="pr-back-files" onClick={onBackFiles}>
              ← ファイル一覧
            </button>
            <span className="pr-overview-kicker">
              {first.changeSet.source} / {`PR #${first.changeSet.id}`}
            </span>
          </>
        )}
        <h1>{first.changeSet.title}</h1>
        <div className="pr-overview-actions">
          <span>
            {items.length}ファイル
            {first.changeSet.kind === "github-repository" ? "の内容" : "の変更"}
          </span>
          {first.changeSet.kind === "github-repository" && (
            <code title="表示中のコミット">
              {first.changeSet.revision?.slice(0, 12)}
            </code>
          )}
          <button onClick={onGenerateOverview} disabled={runningOverview}>
            {runningOverview ? "概要を作成中…" : "概要を作成"}
          </button>
          <button
            className="primary-button"
            onClick={onReviewAll}
            disabled={running > 0}
          >
            {first.changeSet.kind === "github-repository"
              ? "リポジトリ全体をレビュー"
              : "PR全体をレビュー"}
          </button>
          {currentJobs.length > 0 && (
            <details className="pr-conversations">
              <summary>AIの会話（{currentJobs.length}件）</summary>
              <ul>
                {currentJobs.map((job) => (
                  <li key={job.sessionId}>
                    <a
                      href={`/chat/${encodeURIComponent(job.sessionId)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {job.reviewer?.name ?? "AI"} /{" "}
                      {job.purpose === "overview"
                        ? "概要"
                        : `レビュー${job.group ? ` ${job.group.index}/${job.group.total}` : ""}`}
                    </a>
                    <span>
                      {" "}
                      —{" "}
                      {job.status === "running"
                        ? "実行中"
                        : job.status === "failed"
                          ? "失敗"
                          : "完了"}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <a href={first.changeSet.url} target="_blank" rel="noreferrer">
            GitHubで開く
          </a>
        </div>
        {first.changeSet.kind === "github-repository" && exportAction}
      </header>
      {runningOverview && (
        <p className="pr-review-status" role="status">
          概要を作成中です。結果が届くと概要・図解に表示します。
        </p>
      )}
      {running > 0 && (
        <p className="pr-review-status" role="status">
          AIレビュー中: {running}件。結果が届くと
          {first.changeSet.kind === "github-repository"
            ? "説明・レビュー欄"
            : "該当行"}
          に表示します。
        </p>
      )}
      {failed.length > 0 && (
        <p className="pr-review-status error" role="alert">
          AI処理失敗:{" "}
          {failed.map((job) => (
            <span key={job.sessionId}>
              {job.purpose === "overview"
                ? "概要"
                : `レビュー${job.group ? ` ${job.group.index}/${job.group.total}` : ""}`}{" "}
              / {job.reviewer?.name}: {job.error || "実行できませんでした"}{" "}
            </span>
          ))}
        </p>
      )}

      {first.changeSet.kind !== "github-repository" && exportAction}
      <div
        className="software-view-switch"
        role="group"
        aria-label="全体の表示"
      >
        <button
          aria-pressed={view === "overview"}
          onClick={() => setView("overview")}
        >
          概要・図解
        </button>
        <button
          aria-pressed={view === "files"}
          onClick={() => setView("files")}
        >
          ファイル
        </button>
      </div>
      {view === "overview" ? (
        <SoftwareOverview
          items={items}
          onOpenFile={onOpenFile}
          onGenerate={onGenerateOverview}
          running={runningOverview}
        />
      ) : (
        <>
          {first.changeSet.kind === "github-pr" && (
            <PullRequestDescription reviewId={first.id} />
          )}
          {first.changeSet.kind === "github-repository" ? (
            <RepositoryFiles
              key={`${first.changeSet.source}:${first.changeSet.revision}`}
              items={items}
              onOpenFile={onOpenFile}
              onReviewFile={onReviewFile}
            />
          ) : (
            <div className="pr-files-all" aria-label="PR全体の差分">
              {[...items]
                .sort((a, b) =>
                  displayPath(a.file).localeCompare(displayPath(b.file)),
                )
                .map((item) => (
                  <PullRequestFile
                    key={item.id}
                    item={item}
                    onOpenFile={onOpenFile}
                    onReviewFile={onReviewFile}
                  />
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
