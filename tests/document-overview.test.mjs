import test from "node:test";
import assert from "node:assert/strict";
import { documentOverviews } from "../shared/document-overview.mjs";
import { notionPayload } from "../server/notion-content.mjs";
test("document overview distinguishes descriptions from findings and retains reviewers", () => {
  const reviews = [
    {
      id: "one",
      file: "page.txt",
      document: { page: 1, name: "Slides" },
      explanations: [
        {
          heading: "[A] 資料全体の概要",
          summary: "生成AIの使い方を初心者に説明する資料。",
        },
        {
          heading: "[B] 資料全体の概要",
          summary: "文章と画像の生成手順を紹介する。",
        },
        { heading: "改善点", summary: "文字が小さい" },
      ],
    },
  ];
  assert.deepEqual(
    documentOverviews(reviews).map((e) => e.text),
    [
      "生成AIの使い方を初心者に説明する資料。",
      "文章と画像の生成手順を紹介する。",
    ],
  );
  const payload = notionPayload(reviews, "parent");
  assert.equal(
    payload.children[1].heading_2.rich_text[0].text.content,
    "資料全体の概要",
  );
  assert.match(
    payload.children[2].paragraph.rich_text[0].text.content,
    /初心者/,
  );
  assert.deepEqual(
    documentOverviews([
      {
        document: { page: 1 },
        explanations: [{ heading: "指摘", summary: "修正して" }],
      },
    ]),
    [],
  );
});
