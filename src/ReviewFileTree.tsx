import type { ReviewSummary } from "./api";
export function ReviewFileTree({
  items,
  selected,
  disabled,
  onSelect,
}: {
  items: ReviewSummary[];
  selected?: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const render = (entries: ReviewSummary[], depth: number): React.ReactNode => {
    const folders = new Map<string, ReviewSummary[]>();
    const files: ReviewSummary[] = [];
    for (const item of entries) {
      const parts = item.file
        .replace(
          /^changes\/github\/[^/]+\/(?:pr-\d+|repo-[a-f0-9]+)\/[^/]+\//,
          "",
        )
        .split("/");
      if (parts.length <= depth + 1 || item.document) files.push(item);
      else {
        const name = parts[depth];
        folders.set(name, [...(folders.get(name) ?? []), item]);
      }
    }
    return (
      <>
        {[...folders]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, children]) => (
            <details className="review-folder" open key={name}>
              <summary>
                📁 {name} <small>({children.length})</small>
              </summary>
              <div>{render(children, depth + 1)}</div>
            </details>
          ))}
        {files
          .sort((a, b) =>
            a.document && b.document
              ? a.document.page - b.document.page
              : a.file.localeCompare(b.file),
          )
          .map((item) => (
            <button
              key={item.id}
              className={`file-item ${selected === item.id ? "selected" : ""}`}
              aria-current={selected === item.id ? "page" : undefined}
              disabled={disabled}
              onClick={() => onSelect(item.id)}
            >
              <span className="file-detail">
                <strong>
                  {item.document
                    ? `${item.document.page}ページ`
                    : item.file.split("/").at(-1)}
                </strong>
                <span>{item.title}</span>
              </span>
            </button>
          ))}
      </>
    );
  };
  return <div className="review-file-tree">{render(items, 0)}</div>;
}
