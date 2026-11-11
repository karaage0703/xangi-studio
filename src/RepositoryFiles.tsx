import { useEffect, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { reviewApi, type Review, type ReviewSummary } from "./api";
import { CodePane } from "./CodePane";
import { ReviewFileTree } from "./ReviewFileTree";
import { HtmlPreview } from "./HtmlPreview";

const pathOf = (item: ReviewSummary) =>
  item.file.replace(/^changes\/github\/[^/]+\/repo-[a-f0-9]+\/[^/]+\//, "");

export function RepositoryFiles({
  items,
  onOpenFile,
  onReviewFile,
}: {
  items: ReviewSummary[];
  onOpenFile: (id: string) => void;
  onReviewFile: (item: ReviewSummary) => void;
}) {
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [filesOpen, setFilesOpen] = useState(
    () => !matchMedia("(max-width: 800px)").matches,
  );
  const sorted = [...items].sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
  const item =
    items.find((x) => x.id === selected) ??
    sorted.find((x) => /^readme(?:\.md)?$/i.test(pathOf(x))) ??
    sorted[0];
  const filtered = sorted.filter((x) =>
    pathOf(x).toLowerCase().includes(query.toLowerCase()),
  );
  const toggle = (
    <button
      type="button"
      className="icon-button"
      aria-label={filesOpen ? "ファイル一覧を閉じる" : "ファイル一覧を開く"}
      title={filesOpen ? "ファイル一覧を閉じる" : "ファイル一覧を開く"}
      aria-expanded={filesOpen}
      aria-controls="repository-file-panel"
      onClick={() => setFilesOpen(!filesOpen)}
    >
      ☰
    </button>
  );
  return (
    <section
      className={`repository-browser ${filesOpen ? "files-open" : "files-closed"}`}
      aria-label="リポジトリのファイル"
    >
      <aside
        id="repository-file-panel"
        className="repository-navigation"
        hidden={!filesOpen}
        aria-label="リポジトリのファイル一覧"
      >
        <div className="repository-navigation-heading">
          {toggle}
          <h2>
            ファイル一覧 <small>{items.length}</small>
          </h2>
        </div>
        <label>
          ファイルを検索
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ファイル名・パス"
          />
        </label>
        {filtered.length ? (
          <ReviewFileTree
            items={filtered}
            selected={item?.id}
            disabled={false}
            onSelect={(id) => {
              setSelected(id);
              if (matchMedia("(max-width: 800px)").matches) setFilesOpen(false);
            }}
          />
        ) : (
          <p role="status">一致するファイルはありません。</p>
        )}
      </aside>
      {item && (
        <RepositoryFile
          key={item.id}
          item={item}
          navigation={!filesOpen ? toggle : null}
          onOpenFile={onOpenFile}
          onReviewFile={onReviewFile}
        />
      )}
    </section>
  );
}

function RepositoryFile({
  item,
  navigation,
  onOpenFile,
  onReviewFile,
}: {
  item: ReviewSummary;
  navigation: ReactNode;
  onOpenFile: (id: string) => void;
  onReviewFile: (item: ReviewSummary) => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void reviewApi.read(item.id).then(
      (value) => {
        if (active) setReview(value);
      },
      (cause) => {
        if (active) setError(cause.message);
      },
    );
    return () => {
      active = false;
    };
  }, [item, retry]);
  const path = pathOf(item);
  const markdown = /\.md$/i.test(path);
  const html = /\.html?$/i.test(path);
  return (
    <section className="repository-file" aria-label={path}>
      <header className="pr-file-heading">
        <div className="repository-file-title">
          {navigation}
          <strong>{path}</strong>
        </div>
        <div>
          {(markdown || html) && (
            <button aria-pressed={source} onClick={() => setSource(!source)}>
              {source ? (html ? "表示" : "整形表示") : "ソース表示"}
            </button>
          )}
          <button onClick={() => onReviewFile(item)}>
            このファイルをレビュー
          </button>
          <button onClick={() => onOpenFile(item.id)}>個別表示</button>
        </div>
      </header>
      {error ? (
        <div role="alert">
          読み込みに失敗しました: {error}{" "}
          <button onClick={() => setRetry(retry + 1)}>再試行</button>
        </div>
      ) : !review ? (
        <p role="status">本文を読み込み中…</p>
      ) : (
        <>
          {review.explanations?.length ? (
            <details className="repository-findings">
              <summary>説明・レビュー（{review.explanations.length}）</summary>
              {review.explanations.map((note, index) => (
                <article
                  className={`pr-inline-comment severity-${note.severity}`}
                  key={index}
                >
                  <strong>{note.heading}</strong>
                  {note.newStart > 0 && <small> · {note.newStart}行目</small>}
                  <p>{note.summary}</p>
                  {note.impact && <p>{note.impact}</p>}
                  {note.review && (
                    <p className="pr-inline-review">{note.review}</p>
                  )}
                </article>
              ))}
            </details>
          ) : null}
          {review.content === "" ? (
            <p className="pr-file-state">空のファイルです。</p>
          ) : html && !source ? (
            <HtmlPreview
              id={review.id}
              file={review.file}
              content={review.content}
            />
          ) : markdown && !source ? (
            <article className="repository-markdown">
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: ({ alt }) => <span>画像: {alt || "説明なし"}</span>,
                }}
              >
                {review.content}
              </Markdown>
            </article>
          ) : (
            <div className="repository-source">
              <CodePane
                content={review.content}
                file={path}
                mode="read"
                resetKey={`${review.id}:${review.version}`}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
