import { documentOverviews } from "../shared/document-overview.mjs";
import { useEffect, useState } from "react";
import { reviewApi, type Review, type ReviewSummary } from "./api";

export function DocumentPage({
  review,
  pages,
  onSelect,
}: {
  review: Review;
  pages: ReviewSummary[];
  onSelect: (id: string) => void;
}) {
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setImage("");
    setError("");
    void reviewApi
      .pageImage(review.id)
      .then((src) => {
        if (active) setImage(src);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [review.id]);
  const sorted = [...pages].sort((a, b) => a.document!.page - b.document!.page);
  const index = sorted.findIndex((p) => p.id === review.id);
  return (
    <div className="document-view">
      <nav className="document-navigation" aria-label="PDFページ移動">
        <button
          disabled={index <= 0}
          onClick={() => onSelect(sorted[index - 1].id)}
        >
          前のページ
        </button>
        <label>
          ページ{" "}
          <select
            aria-label="PDFページ"
            value={review.id}
            onChange={(e) => onSelect(e.target.value)}
          >
            {sorted.map((p) => (
              <option key={p.id} value={p.id}>
                {p.document!.page} / {p.document!.pages}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={index >= sorted.length - 1}
          onClick={() => onSelect(sorted[index + 1].id)}
        >
          次のページ
        </button>
      </nav>
      <div className="document-columns">
        <div className="document-slide">
          <div className="document-image">
            {error ? (
              <p role="alert">
                {review.document!.page}ページ: {error}
              </p>
            ) : image ? (
              <img
                src={image}
                alt={`${review.document!.name} ${review.document!.page}ページ`}
              />
            ) : (
              <p>ページ画像を読み込み中…</p>
            )}
          </div>
          <section className="document-overview" aria-label="資料全体の概要">
            <h2>資料全体の概要</h2>
            {documentOverviews(pages).length ? (
              documentOverviews(pages).map((entry, index) => (
                <div key={index}>
                  <strong>{entry.label}</strong>
                  <p>{entry.text}</p>
                </div>
              ))
            ) : (
              <p>
                概要は未作成です。「レビューを開始」でページごとの確認と概要を作成できます。
              </p>
            )}
          </section>
        </div>
        <aside className="document-notes" aria-label="ページのレビュー">
          <h2>{review.document!.page}ページのレビュー</h2>
          {review.explanations?.map((e, index) =>
            e.heading.endsWith("資料全体の概要") ? null : (
              <article
                key={index}
                className={`document-note severity-${e.severity}`}
              >
                <h3>
                  {e.severity === "danger"
                    ? "危険 · "
                    : e.severity === "warning"
                      ? "要注意 · "
                      : ""}
                  {e.heading}
                </h3>
                <p>{e.summary}</p>
                <p>{e.review}</p>
                {e.impact && <p>{e.impact}</p>}
              </article>
            ),
          )}
          <details>
            <summary>抽出テキスト</summary>
            <pre>
              {review.content ||
                "抽出テキストがありません。ページ画像を確認してください。"}
            </pre>
          </details>
        </aside>
      </div>
    </div>
  );
}
