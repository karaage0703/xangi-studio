import { useEffect, useState } from "react";
import { request } from "./api";
import { buildHtmlPreview, type PreviewFile } from "./html-preview";

export function HtmlPreview({
  id,
  file,
  content,
}: {
  id: string;
  file: string;
  content: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    url: string;
    warnings: string[];
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setResult(null);
    setError("");
    void (async () => {
      const { files } = await request<{ files: PreviewFile[] }>(
        `/api/reviews/${encodeURIComponent(id)}/preview-files`,
        { signal: controller.signal },
      );
      if (!active) return;
      const built = buildHtmlPreview(content, file, files);
      const preview = await request<{ path: string }>("/api/html-previews", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ content: built.html }),
      });
      if (!active) return;
      const base = location.pathname.startsWith("/api/extensions/")
        ? document.baseURI
        : location.origin + "/";
      setResult({
        url: new URL(preview.path.replace(/^\//, ""), base).toString(),
        warnings: built.warnings,
      });
    })()
      .catch((cause) => {
        if (active)
          setError(
            controller.signal.aborted
              ? "プレビューの応答がありません。再読み込みしてください。"
              : (cause as Error).message,
          );
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [id, file, content, attempt]);
  return (
    <section className="html-preview" aria-label="HTMLプレビュー">
      <div className="html-preview-toolbar">
        <span>HTMLプレビュー</span>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          プレビューを再読み込み
        </button>
      </div>
      <p className="html-preview-caption">
        プレビュー内の操作や進行は保存されません。
      </p>
      {error ? (
        <p role="alert">プレビューを表示できませんでした: {error}</p>
      ) : !result ? (
        <p role="status">プレビューを準備中…</p>
      ) : (
        <>
          {result.warnings.length > 0 && (
            <details className="html-preview-notes">
              <summary>
                読み込めない参照があります（{result.warnings.length}件）
              </summary>
              <ul>
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          <iframe
            title={`${file.split("/").at(-1)}のHTMLプレビュー`}
            src={result.url}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        </>
      )}
    </section>
  );
}
