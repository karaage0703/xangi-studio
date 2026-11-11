import { workspacePath } from "./api";
import { useEffect, useState, useRef } from "react";
import { reviewApi, request, type ReviewSummary } from "./api";
import { pullRequestLabel, githubGroupKey } from "../shared/pr-label.mjs";

type HomeReview = Pick<
  ReviewSummary,
  "id" | "title" | "file" | "createdAt" | "document"
> & {
  changeSet?: Pick<
    NonNullable<ReviewSummary["changeSet"]>,
    "kind" | "id" | "source" | "title" | "revision"
  >;
};
export function ArtifactList({
  onNavigate,
  onClose,
}: {
  onNavigate: (href: string) => void;
  onClose?: () => void;
}) {
  const [reviews, setReviews] = useState<HomeReview[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState(
    () => sessionStorage.getItem("studio-artifact-search") ?? "",
  );
  useEffect(() => {
    sessionStorage.setItem("studio-artifact-search", query);
  }, [query]);
  const previous = useRef<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        if (document.hidden) return;
        const [r, p] = await Promise.all([
          request<HomeReview[]>("/api/reviews?summary=home"),
          reviewApi.preferences(),
        ]);
        if (alive && (previous.current[0] !== r || previous.current[1] !== p)) {
          previous.current = [r, p];
          setReviews(
            r.filter(
              (x) =>
                !p.archivedChangeSets.some(
                  (a) =>
                    a.kind === x.changeSet?.kind &&
                    a.id === x.changeSet?.id &&
                    a.source === x.changeSet?.source,
                ),
            ),
          );
          setError("");
        }
        if (alive) setError("");
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) {
          setLoading(false);
          timer = setTimeout(load, 4000);
        }
      }
    }
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  const params = new URLSearchParams(location.search);
  const selectedReview = reviews.find((r) => r.id === params.get("review"));
  const groups = Array.from(
    new Map(
      reviews.map((r) => [
        r.changeSet
          ? JSON.stringify([
              r.changeSet.kind,
              r.changeSet.source,
              r.changeSet.id,
              r.changeSet.kind === "github-repository"
                ? r.changeSet.revision
                : null,
            ])
          : r.id,
        r,
      ]),
    ).values(),
  );
  const entries = [
    ...groups.map((r) => ({
      key: "review-" + r.id,
      selected:
        params.get("pr") === githubGroupKey(r.changeSet) ||
        params.get("review") === r.id ||
        Boolean(
          r.changeSet &&
          selectedReview?.changeSet &&
          r.changeSet.kind === selectedReview.changeSet.kind &&
          r.changeSet.source === selectedReview.changeSet.source &&
          r.changeSet.id === selectedReview.changeSet.id,
        ),
      title: r.changeSet?.title || r.title,
      label: r.document
        ? "取り込んだ資料"
        : r.changeSet?.kind === "workspace"
          ? "ローカルリポジトリ"
          : ["github-pr", "github-repository"].includes(r.changeSet?.kind ?? "")
            ? pullRequestLabel(r.changeSet)!
            : "取り込んだ原稿",
      url: ["github-pr", "github-repository"].includes(r.changeSet?.kind ?? "")
        ? `?pr=${encodeURIComponent(githubGroupKey(r.changeSet))}`
        : `?review=${encodeURIComponent(r.id)}`,
      at: Date.parse(r.createdAt) || 0,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .filter((x) =>
      `${x.title} ${x.label}`.toLowerCase().includes(query.toLowerCase()),
    );
  return (
    <nav className="artifact-list" aria-label="成果物一覧">
      <div className="artifact-list-heading">
        <h2>成果物</h2>
        {onClose && (
          <button
            type="button"
            className="icon-button"
            aria-label="サイドバーを閉じる"
            title="サイドバーを閉じる"
            onClick={onClose}
          >
            ‹
          </button>
        )}
      </div>
      <a
        className="artifact-import"
        href={`${workspacePath}?import=1`}
        onClick={(e) => {
          if (
            e.button === 0 &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.shiftKey &&
            !e.altKey
          ) {
            e.preventDefault();
            onNavigate(e.currentTarget.href);
          }
        }}
      >
        ＋ PR・リポジトリ・資料の取り込み
      </a>
      <label>
        成果物を検索
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p role="status">読み込み中…</p>
      ) : entries.length === 0 ? (
        <p>
          表示する成果物はありません。「PR・リポジトリ・資料の取り込み」から追加できます。
        </p>
      ) : (
        <ul className="workspace-artifacts">
          {entries.map((e) => (
            <li key={e.key}>
              <a
                href={`${workspacePath}${e.url}`}
                aria-current={e.selected ? "page" : undefined}
                onClick={(event) => {
                  if (
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    onNavigate(event.currentTarget.href);
                  }
                }}
              >
                <strong>{e.title}</strong>
                <span>{e.label}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
