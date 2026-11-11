import { diffLines } from "diff";

export function buildPullRequestRows(
  before,
  after,
  explanations = [],
  contextLines = 3,
) {
  const rows = [];
  let oldLine = 1;
  let newLine = 1;
  for (const change of diffLines(
    before.replaceAll("\r\n", "\n"),
    after.replaceAll("\r\n", "\n"),
  )) {
    const lines = change.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const text of lines) {
      if (change.added)
        rows.push({ kind: "added", newLine: newLine++, text, comments: [] });
      else if (change.removed)
        rows.push({ kind: "removed", oldLine: oldLine++, text, comments: [] });
      else
        rows.push({
          kind: "context",
          oldLine: oldLine++,
          newLine: newLine++,
          text,
          comments: [],
        });
    }
  }
  const changed = rows
    .map((row, index) => (row.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);
  for (const [index, explanation] of explanations.entries()) {
    const exact =
      changed.find(
        (at) =>
          rows[at].newLine === explanation.newStart && explanation.newStart > 0,
      ) ??
      changed.find(
        (at) =>
          rows[at].oldLine === explanation.oldStart && explanation.oldStart > 0,
      );
    const nearest =
      exact ??
      changed.reduce(
        (best, at) => {
          const row = rows[at];
          const distance = Math.min(
            row.newLine && explanation.newStart
              ? Math.abs(row.newLine - explanation.newStart)
              : Infinity,
            row.oldLine && explanation.oldStart
              ? Math.abs(row.oldLine - explanation.oldStart)
              : Infinity,
          );
          return distance < best.distance ? { at, distance } : best;
        },
        { at: changed[0] ?? 0, distance: Infinity },
      ).at;
    if (rows[nearest]) rows[nearest].comments.push(index);
  }
  const visible = new Set();
  for (const at of changed) {
    for (let offset = -contextLines; offset <= contextLines; offset++) {
      if (at + offset >= 0 && at + offset < rows.length)
        visible.add(at + offset);
    }
  }
  for (const [index, row] of rows.entries())
    if (row.comments.length) visible.add(index);
  const shown = [];
  let omitted = 0;
  for (const [index, row] of rows.entries()) {
    if (!visible.has(index)) {
      omitted++;
      continue;
    }
    if (omitted) {
      shown.push({ kind: "omitted", count: omitted, comments: [] });
      omitted = 0;
    }
    shown.push(row);
  }
  if (omitted) shown.push({ kind: "omitted", count: omitted, comments: [] });
  return shown;
}
