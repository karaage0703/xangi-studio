import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSoftwareOverview } from "../shared/software-overview.mjs";
import {
  parseAutoReviewResult,
  buildAutoReviewPrompt,
  buildOverviewPrompt,
} from "../shared/auto-review.mjs";
const valid = () => ({
  summary: "用途",
  before: "以前",
  after: "現在",
  nodes: [
    {
      id: "a",
      label: "画面",
      description: "入力を受ける",
      files: ["src/a.ts"],
    },
  ],
  edges: [],
  decisions: [],
  limitations: ["テスト未実行"],
});
test("structured overview validates references, graph endpoints and bounds", () => {
  assert.deepEqual(normalizeSoftwareOverview(valid(), ["src/a.ts"]), valid());
  for (const value of [
    { ...valid(), nodes: [...valid().nodes, ...valid().nodes] },
    { ...valid(), edges: [{ from: "a", to: "missing", label: "呼出し" }] },
    { ...valid(), summary: "a".repeat(2001) },
    {
      ...valid(),
      decisions: [
        {
          fact: "事実",
          reason: "理由",
          question: "問い",
          files: ["../outside"],
        },
      ],
    },
  ])
    assert.throws(() => normalizeSoftwareOverview(value, ["src/a.ts"]));
  assert.throws(() => normalizeSoftwareOverview(valid(), []));
  assert.equal(normalizeSoftwareOverview(undefined, []), undefined);
});
test("review parser preserves optional overview without breaking legacy replies", () => {
  assert.deepEqual(
    parseAutoReviewResult(
      JSON.stringify({ files: { "src/a.ts": [] }, overview: valid() }),
    ).overview,
    valid(),
  );
  assert.equal(parseAutoReviewResult('{"files":{}}').overview, undefined);
  const prompt = buildAutoReviewPrompt(
    "https://github.com/example/repo/pull/1",
    ["src/a.ts"],
    undefined,
    { revision: "base:head" },
  );
  assert.match(prompt, /base:head/);
  assert.doesNotMatch(prompt, /"overview"/);
  const overviewPrompt = buildOverviewPrompt(
    "https://github.com/example/repo/pull/1",
    ["src/a.ts"],
    { revision: "base:head" },
  );
  assert.match(overviewPrompt, /"overview"/);
  assert.match(overviewPrompt, /人間の承認/);
});
