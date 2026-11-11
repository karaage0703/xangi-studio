import { documentOverviews } from "../shared/document-overview.mjs";
import { ApiError } from "./store.mjs";
const rich = (text) =>
  Array.from(
    { length: Math.ceil(String(text).length / 1800) || 1 },
    (_, i) => ({
      type: "text",
      text: { content: String(text).slice(i * 1800, (i + 1) * 1800) },
    }),
  );
const paragraph = (text) => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: rich(text) },
});
const codes = (text, label) => {
  const chunks = rich(text ?? "");
  const result = [paragraph(label)];
  for (let i = 0; i < chunks.length; i += 50)
    result.push({
      object: "block",
      type: "code",
      code: { language: "plain text", rich_text: chunks.slice(i, i + 50) },
    });
  return result;
};
export function notionPayload(reviews, parent) {
  const first = reviews[0];
  const title = first.changeSet?.title || first.document?.name || first.title;
  const children = [
    paragraph(
      `対象: ${first.changeSet?.url ?? first.file}\n版: ${first.changeSet?.revision ?? first.createdAt}\n保存対象: レビュー・コード変更前後・資料ページ画像とテキスト`,
    ),
  ];
  if (first.document) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: rich("資料全体の概要") },
    });
    const overviews = documentOverviews(reviews);
    if (overviews.length)
      for (const entry of overviews)
        children.push(paragraph(`${entry.label}\n${entry.text}`));
    else
      children.push(
        paragraph(
          "概要は未作成です。再レビュー後に保存すると資料全体の概要が含まれます。",
        ),
      );
  }
  for (const r of reviews) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: rich(
          (r.document
            ? `${r.document.name} — ${r.document.page}ページ`
            : r.file.replace(
                /^changes\/github\/[^/]+\/(?:pr-\d+|repo-[a-f0-9]+)\/[^/]+\//,
                "",
              )
          ).slice(0, 300),
        ),
      },
    });
    for (const e of (r.explanations ?? []).filter(
      (e) => !r.document || !(e.heading ?? "").endsWith("資料全体の概要"),
    )) {
      const chunks = rich(
        `[${e.severity ?? "info"}] ${e.heading ?? ""}\n${e.summary ?? ""}\n${e.impact ?? ""}\n${e.review ?? ""}`,
      );
      for (let i = 0; i < chunks.length; i += 50)
        children.push({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: chunks.slice(i, i + 50) },
        });
    }
    if (r.document) {
      children.push({
        object: "block",
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: `pending:${r.id}` },
          caption: rich(`${r.document.page}ページ`),
        },
      });
      children.push(...codes(r.content, "ページのテキスト"));
    } else
      children.push(
        ...codes(r.before, "変更前"),
        ...codes(r.content, "変更後"),
      );
  }
  return {
    parent: { page_id: parent },
    properties: { title: { title: rich(`Review: ${title}`.slice(0, 150)) } },
    children,
  };
}
export function blockBatches(children) {
  const batches = [];
  let current = [];
  for (const block of children) {
    if (Buffer.byteLength(JSON.stringify({ children: [block] })) > 440000)
      throw new ApiError(413, "Notionの1ブロック上限を超えています。");
    if (
      current.length >= 100 ||
      Buffer.byteLength(JSON.stringify({ children: [...current, block] })) >
        440000
    ) {
      batches.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length) batches.push(current);
  return batches;
}
