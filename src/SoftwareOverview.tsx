import type { ReviewSummary } from "./api";
import { sourcePath } from "../shared/software-overview.mjs";

export function SoftwareOverview({
  items,
  onOpenFile,
  onGenerate,
  running,
}: {
  items: ReviewSummary[];
  onOpenFile: (id: string) => void;
  onGenerate: () => void;
  running: boolean;
}) {
  const revision = items[0]?.changeSet?.revision;
  const overview = items
    .map((i) => i.softwareOverview)
    .filter((o) => o?.revision === revision)
    .sort((a, b) => b!.generatedAt.localeCompare(a!.generatedAt))[0];
  const refs = (files: string[]) => (
    <div className="software-source-links">
      {files.map((file) => {
        const item = items.find(
          (i) =>
            i.changeSet?.revision === revision && sourcePath(i.file) === file,
        );
        return item ? (
          <button key={file} onClick={() => onOpenFile(item.id)}>
            {file}
          </button>
        ) : (
          <span key={file}>根拠を開けません: {file}</span>
        );
      })}
    </div>
  );
  if (!overview)
    return (
      <section className="software-overview" aria-label="全体概要">
        <h2>概要はまだ生成されていません</h2>
        <p>
          目的・構成図・変更前後・人に確認したい判断点を作成します。レビューは別に実行できます。既存のファイルと差分は「ファイル」から確認できます。
        </p>
        <button
          className="primary-button"
          onClick={onGenerate}
          disabled={running}
        >
          {running ? "概要を作成中…" : "概要を生成する"}
        </button>
        <p>AIを実行します。生成結果は表示中の版に結び付けて保存されます。</p>
      </section>
    );
  return (
    <article className="software-overview" aria-label="全体概要">
      <header>
        <h2>全体像</h2>
        <p>{overview.summary}</p>
        <p className="software-metadata">
          AI生成・人の承認は未確認 / {overview.reviewer} /{" "}
          <time dateTime={overview.generatedAt}>
            {new Date(overview.generatedAt).toLocaleString()}
          </time>
        </p>
        <details>
          <summary>対象版と確認範囲</summary>
          <code className="software-revision">{revision}</code>
          <p>
            取込済みの{items.length}
            ファイルに基づく概要です。取り込まれていないファイルを網羅するものではありません。更新後は新しい版で再生成してください。
          </p>
        </details>
      </header>
      <section className="software-comparison" aria-label="前提と動作の比較">
        <div>
          <h3>
            {items[0]?.changeSet?.kind === "github-repository"
              ? "前提"
              : "変更前"}
          </h3>
          <p>{overview.before}</p>
        </div>
        <div>
          <h3>
            {items[0]?.changeSet?.kind === "github-repository"
              ? "主な動作"
              : "変更後"}
          </h3>
          <p>{overview.after}</p>
        </div>
      </section>
      <section aria-label="構成図">
        <h2>構成と関係</h2>
        <p>要素の役割とつながりを示します。ファイル名から根拠を開けます。</p>
        <div className="software-nodes">
          {overview.nodes.map((node) => (
            <section key={node.id} className="software-node">
              <h3>{node.label}</h3>
              <p>{node.description}</p>
              {refs(node.files)}
            </section>
          ))}
        </div>
        {overview.edges.length ? (
          <ul className="software-edges" aria-label="要素間の関係">
            {overview.edges.map((edge, i) => (
              <li key={i}>
                <strong>
                  {overview.nodes.find((n) => n.id === edge.from)?.label}
                </strong>
                <span className="software-edge-label">
                  {edge.label}
                  <span aria-hidden="true"> → </span>
                </span>
                <strong>
                  {overview.nodes.find((n) => n.id === edge.to)?.label}
                </strong>
              </li>
            ))}
          </ul>
        ) : (
          <p>要素間の関係は確認されていません。</p>
        )}
      </section>
      <section aria-label="人に確認したい判断点">
        <h2>人に確認したい判断点</h2>
        {overview.decisions.length ? (
          overview.decisions.map((decision, i) => (
            <section className="software-decision" key={i}>
              <h3>判断 {i + 1} · 未確認</h3>
              <dl>
                <dt>事実</dt>
                <dd>{decision.fact}</dd>
                <dt>理由</dt>
                <dd>{decision.reason}</dd>
                <dt>問い</dt>
                <dd>{decision.question}</dd>
              </dl>
              {refs(decision.files)}
            </section>
          ))
        ) : (
          <p>
            AIが挙げた判断点はありません。すべての設計が承認されたことを意味しません。
          </p>
        )}
      </section>
      <section aria-label="検証と未確認">
        <h2>検証と未確認</h2>
        <p>AIが記載した確認範囲です。この画面はテストを実行しません。</p>
        {overview.limitations.length ? (
          <ul>
            {overview.limitations.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        ) : (
          <p>確認範囲の記載がありません。検証済みとは判断できません。</p>
        )}
      </section>
    </article>
  );
}
