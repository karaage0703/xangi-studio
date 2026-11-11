import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { request } from "./api";

type Description = {
  title: string;
  body: string;
  url: string;
  updatedAt?: string;
};

export function PullRequestDescription({ reviewId }: { reviewId: string }) {
  const [description, setDescription] = useState<Description | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setDescription(null);
    setError("");
    void request<Description>(
      `/api/reviews/${encodeURIComponent(reviewId)}/github-description`,
    )
      .then((value) => {
        if (active) setDescription(value);
      })
      .catch(() => {
        if (active)
          setError(
            "PR本文を取得できませんでした。GitHubへの接続とアクセス権を確認してください。",
          );
      });
    return () => {
      active = false;
    };
  }, [reviewId, attempt]);
  return (
    <details className="pr-description" open>
      <summary>PR本文</summary>
      <div className="pr-description-content">
        {error ? (
          <p role="alert">
            {error}{" "}
            <button onClick={() => setAttempt((n) => n + 1)}>再取得</button>
          </p>
        ) : !description ? (
          <p role="status">PR本文を読み込み中…</p>
        ) : (
          <>
            <strong>{description.title}</strong>
            <small>GitHubの現在の本文</small>
            {description.body ? (
              <article className="markdown-body">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ children, ...props }) => (
                      <a {...props} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {description.body}
                </Markdown>
              </article>
            ) : (
              <p>このPRには本文がありません。</p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
