import { useEffect, useState, useRef, type ReactNode } from "react";
import "./draft-status.css";
export function DraftStatusBar({
  autosave,
  characterCount,
  actions,
  actionError,
}: {
  autosave: {
    status: string;
    error: string;
    retry: () => unknown;
  };
  characterCount: number;
  actions?: ReactNode;
  actionError?: string;
}) {
  const [bottom, setBottom] = useState(0);
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const measure = () =>
      document.documentElement.style.setProperty(
        "--draft-bar-height",
        `${element.getBoundingClientRect().height}px`,
      );
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--draft-bar-height");
    };
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () =>
      setBottom(
        Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop),
      );
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  const labels: Record<string, string> = {
    loading: "下書きを読み込み中",
    saving: "保存中",
    saved: "保存済み",
    failed: "保存失敗",
  };
  return (
    <footer
      ref={bar}
      className={`draft-status-bar status-${autosave.status}`}
      style={{ bottom }}
      aria-label="下書きの保存状態"
    >
      <div className="draft-save-information">
        <span role="status" aria-live="polite" aria-atomic="true">
          下書き · {labels[autosave.status]}
        </span>
        {actionError && (
          <span className="draft-save-error">保存エラー: {actionError}</span>
        )}
        <span aria-label="文字数" title="空白・改行を含む文字数">
          {characterCount.toLocaleString("ja-JP")}文字
        </span>
        {autosave.error && (
          <span className="draft-save-error" title={autosave.error}>
            {autosave.error}
          </span>
        )}
      </div>
      <div className="draft-save-actions">
        {autosave.status === "failed" && (
          <>
            <button onClick={() => void autosave.retry()}>再試行</button>
          </>
        )}
        {actions}
      </div>
    </footer>
  );
}
