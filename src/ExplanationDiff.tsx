import { diffLines } from "diff";
import type { Explanation } from "./api";

type DiffRow = {
  kind: "context" | "added" | "removed";
  oldLine?: number;
  newLine?: number;
  text: string;
};

type Props = {
  before: string;
  after: string;
  explanation: Explanation;
};

export function explanationDiffRows({
  before,
  after,
  explanation,
}: Props): DiffRow[] {
  let oldLine = 1;
  let newLine = 1;
  const rows: DiffRow[] = [];

  for (const change of diffLines(
    before.replaceAll("\r\n", "\n"),
    after.replaceAll("\r\n", "\n"),
  )) {
    const lines = change.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const text of lines) {
      if (change.removed) {
        rows.push({ kind: "removed", oldLine, text });
        oldLine += 1;
      } else if (change.added) {
        rows.push({ kind: "added", newLine, text });
        newLine += 1;
      } else {
        rows.push({ kind: "context", oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
      }
    }
  }

  const changed = rows.flatMap((row, index) =>
    row.kind === "context" ? [] : [index],
  );
  if (changed.length === 0) return [];
  const targetOld = explanation.oldStart || explanation.newStart;
  const targetNew = explanation.newStart || explanation.oldStart;
  const nearest = changed.reduce(
    (best, index) => {
      const row = rows[index];
      const distance = Math.min(
        row.oldLine === undefined
          ? Number.POSITIVE_INFINITY
          : Math.abs(row.oldLine - targetOld),
        row.newLine === undefined
          ? Number.POSITIVE_INFINITY
          : Math.abs(row.newLine - targetNew),
      );
      return distance < best.distance ? { index, distance } : best;
    },
    { index: changed[0], distance: Number.POSITIVE_INFINITY },
  ).index;
  let first = changed.indexOf(nearest);
  let last = first;
  while (first > 0 && changed[first] - changed[first - 1] <= 4) first -= 1;
  while (last < changed.length - 1 && changed[last + 1] - changed[last] <= 4)
    last += 1;
  return rows.slice(
    Math.max(0, changed[first] - 3),
    Math.min(rows.length, changed[last] + 4),
  );
}

export function ExplanationDiff(props: Props) {
  const rows = explanationDiffRows(props);
  const hasChanges = rows.some((row) => row.kind !== "context");

  return (
    <section className="explanation-diff" aria-label="説明に対応する差分">
      <div className="explanation-diff-heading">
        <div>
          <strong>
            {props.explanation.severity === "danger"
              ? "危険："
              : props.explanation.severity === "warning"
                ? "要注意："
                : ""}
            {props.explanation.heading}
          </strong>
          <span>対応する差分</span>
          {props.explanation.review && (
            <span
              className={`diff-review-comment severity-${props.explanation.severity}`}
            >
              レビュー：{props.explanation.review}
            </span>
          )}
        </div>
        <code>
          {props.explanation.oldStart
            ? `変更前 ${props.explanation.oldStart}行`
            : "新規"}
          {" → "}
          {props.explanation.newStart
            ? `変更後 ${props.explanation.newStart}行`
            : "削除"}
        </code>
      </div>
      {hasChanges ? (
        <div className="explanation-diff-scroll" tabIndex={0}>
          <div className="explanation-diff-code">
            {rows.map((row, index) => (
              <div
                className={`diff-row ${row.kind}`}
                key={`${index}-${row.text}`}
              >
                <span className="diff-marker" aria-hidden="true">
                  {row.kind === "added"
                    ? "+"
                    : row.kind === "removed"
                      ? "−"
                      : " "}
                </span>
                <span className="diff-line-number">{row.oldLine ?? ""}</span>
                <span className="diff-line-number">{row.newLine ?? ""}</span>
                <code>{row.text || " "}</code>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="explanation-diff-empty">
          この説明の行付近に変更行を見つけられませんでした。ファイル全体の差分で確認してください。
        </p>
      )}
    </section>
  );
}
