// Structured text only: no generated HTML, SVG, scripts, or external resources.
export const sourcePath = (file) =>
  file.replace(
    /^changes\/github\/[^/]+\/(?:pr-\d+|repo-[a-f0-9]+)\/[^/]+\//,
    "",
  );

export function normalizeSoftwareOverview(value, paths) {
  if (value === undefined) return undefined;
  const fail = () => {
    throw new Error("全体概要の形式または根拠ファイルが正しくありません。");
  };
  const text = (v, max = 2000) =>
    typeof v === "string" && v.trim() && v.length <= max ? v.trim() : fail();
  const list = (v, max) => (Array.isArray(v) && v.length <= max ? v : fail());
  const refs = (v) => list(v, 20).map((p) => (paths.includes(p) ? p : fail()));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const nodes = list(value.nodes, 16).map((n) => ({
    id: text(n?.id, 40),
    label: text(n?.label, 120),
    description: text(n?.description),
    files: refs(n?.files),
  }));
  if (
    !nodes.length ||
    nodes.some((n) => !n.files.length) ||
    new Set(nodes.map((n) => n.id)).size !== nodes.length
  )
    fail();
  const ids = new Set(nodes.map((n) => n.id));
  return {
    summary: text(value.summary),
    before: text(value.before),
    after: text(value.after),
    nodes,
    edges: list(value.edges, 24).map((e) =>
      ids.has(e?.from) && ids.has(e?.to)
        ? {
            from: e.from,
            to: e.to,
            label: text(e.label, 200),
          }
        : fail(),
    ),
    decisions: list(value.decisions, 16).map((d) => ({
      fact: text(d?.fact),
      reason: text(d?.reason),
      question: text(d?.question),
      files: refs(d?.files),
    })),
    limitations: list(value.limitations, 20).map((v) => text(v)),
  };
}

export const softwareOverviewPrompt = [
  "JSONのoverviewに人向けの全体概要を返してください。目的・代表的な使い方・影響をsummaryに簡潔に説明してください。",
  '"overview":{"summary":"誰の何を解決するかと使い方","before":"変更前。リポジトリ全体なら現状の前提","after":"変更後。リポジトリ全体なら主な動作","nodes":[{"id":"ui","label":"画面","description":"役割","files":["src/example.ts"]}],"edges":[],"decisions":[{"fact":"設計した事実","reason":"その理由","question":"人に確認する具体的な問い","files":["src/example.ts"]}],"limitations":["未実行の検証・未確認や取得できなかった情報"]}',
  "nodesは最大16個、edgesは最大24個でfrom/toにnodeのid、labelに関係の意味を指定。decisionsは最大16個、無ければ空配列。nodesのfilesには必ず今回の対象ファイル名を指定。実際のコードで確かめた関係だけを図にし、ファイル一覧だけを関係図にしないでください。",
  "仕様からの推測と確認した事実を区別し、テストを実行していないならlimitationsに明記してください。AIの見解を人間の承認として記載しないでください。各説明は2000文字以内。Markdown・HTML・実行コードをフィールドに含めずテキストで記載してください。",
].join("\n");
