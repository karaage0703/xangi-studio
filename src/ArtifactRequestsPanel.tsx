import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { request } from "./api";
import "./artifact-requests.css";

type Work = {
  id: string;
  instruction: string;
  status: string;
  sessionId?: string;
  result?: string;
  error?: string;
};
type Options = {
  projects: { id: string; name: string }[];
  agents: { id: string; name: string }[];
};
const labels: Record<string, string> = {
  dispatching: "受付中",
  queued: "待機中",
  running: "依頼中",
  succeeded: "完了",
  failed: "失敗",
  interrupted: "受付未確認",
};
export function ArtifactRequestsPanel({
  reviewId,
  version,
  blockedReason,
}: {
  reviewId: string;
  version: string;
  blockedReason: string;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [destination, setDestination] = useState("");
  const [instruction, setInstruction] = useState("");
  const [works, setWorks] = useState<Work[]>([]);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [optionsError, setOptionsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const receipt = useRef<{ id: string; body: string } | null>(null);
  const submitting = useRef(false);
  const active = works.some((w) =>
    ["dispatching", "queued", "running"].includes(w.status),
  );
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        if (document.hidden) return;
        const list = await request<Work[]>(
          `/api/reviews/${reviewId}/requests`,
          { signal: AbortSignal.timeout(15000) },
        );
        if (!Array.isArray(list))
          throw new Error("依頼履歴を取得できませんでした。");
        if (alive) {
          setWorks(list);
          setReady(true);
          setLoadError("");
        }
      } catch (e) {
        if (alive) setLoadError((e as Error).message);
      } finally {
        if (alive) timer = setTimeout(load, 2000);
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [reviewId]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void request<Options>("/api/request-options", {
      signal: AbortSignal.timeout(15000),
    })
      .then((value) => {
        if (alive) {
          setOptions(value);
          setOptionsError("");
        }
      })
      .catch((e) => {
        if (alive) setOptionsError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [open]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      submitting.current ||
      active ||
      !ready ||
      !options ||
      blockedReason ||
      !instruction.trim()
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const body = {
      instruction: instruction.trim(),
      expectedVersion: version,
      projectId: destination.startsWith("project:") ? destination.slice(8) : "",
      agentId: destination.startsWith("agent:") ? destination.slice(6) : "",
    };
    const encoded = JSON.stringify(body);
    if (receipt.current?.body !== encoded)
      receipt.current = { id: crypto.randomUUID(), body: encoded };
    try {
      const work = await request<Work>(`/api/reviews/${reviewId}/requests`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ ...body, requestId: receipt.current.id }),
      });
      setWorks((current) => [...current.filter((w) => w.id !== work.id), work]);
      setInstruction("");
      receipt.current = null;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="artifact-requests" aria-label="xangiへの依頼">
      <details
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>xangiへ依頼{active ? "（依頼中）" : ""}</summary>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor={`destination-${reviewId}`}>依頼先</label>
          <select
            id={`destination-${reviewId}`}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            disabled={busy || !options}
          >
            <option value="">xangiの既定設定</option>
            <optgroup label="プロジェクト">
              {options?.projects.map((p) => (
                <option key={p.id} value={`project:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="エージェント">
              {options?.agents.map((a) => (
                <option key={a.id} value={`agent:${a.id}`}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          </select>
          <label htmlFor={`request-${reviewId}`}>依頼内容（必須）</label>
          <textarea
            id={`request-${reviewId}`}
            rows={3}
            maxLength={4000}
            required
            value={instruction}
            disabled={busy}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="例：結論を先にして、説明を短くして"
          />
          <small>
            現在の保存済み本文を添えて依頼します。続きの指示はxangiの会話で送れます。
          </small>
          {blockedReason && <p role="status">{blockedReason}</p>}
          {optionsError && (
            <p role="alert">
              {optionsError} フォームを開き直して再取得してください。
            </p>
          )}
          <button
            className="primary-button"
            type="submit"
            disabled={
              busy ||
              active ||
              !ready ||
              !options ||
              !!blockedReason ||
              !instruction.trim()
            }
          >
            {busy
              ? "依頼しています…"
              : active
                ? "xangiが作業中"
                : "xangiへ依頼"}
          </button>
        </form>
      </details>
      {loadError && <p role="alert">{loadError}</p>}
      {error && <p role="alert">{error}</p>}
      {works.length > 0 && (
        <ul className="artifact-request-history">
          {[...works].reverse().map((work) => (
            <li key={work.id}>
              <strong>{work.instruction}</strong>
              <span role="status">{labels[work.status] || work.status}</span>
              {work.sessionId && (
                <a
                  href={`/chat/${encodeURIComponent(work.sessionId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  xangiの会話を開く
                </a>
              )}
              {work.error && <p role="alert">{work.error}</p>}
              {work.result && (
                <details>
                  <summary>回答を読む</summary>
                  <div className="markdown-body">
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ children, ...props }) => (
                          <a {...props} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ),
                        img: ({ alt }) => <span>{alt || "画像"}</span>,
                      }}
                    >
                      {work.result}
                    </Markdown>
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
