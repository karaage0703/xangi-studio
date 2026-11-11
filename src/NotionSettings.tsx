import { useEffect, useRef, useState } from "react";
import { request } from "./api";
type Settings = {
  configured: boolean;
  hasToken: boolean;
  parentPageId: string;
  tokenLocked: boolean;
  parentLocked: boolean;
};
export function NotionSettings({
  onSaved,
}: {
  onSaved?: (configured: boolean) => void;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [parent, setParent] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true;
    void request<Settings>("/api/notion")
      .then((s) => {
        if (alive) {
          setSettings(s);
          setParent(s.parentPageId ?? "");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  async function save(check: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const s = settings?.parentLocked
        ? settings
        : await request<Settings>("/api/notion/settings", {
            method: "POST",
            body: JSON.stringify({
              parentPageId: parent,
              ...(token.trim() ? { token } : {}),
            }),
          });
      setSettings(s);
      setToken("");
      onSaved?.(s.configured);
      if (check) {
        const result = await request<{ message: string }>("/api/notion/check", {
          method: "POST",
          body: "{}",
        });
        setNotice(result.message);
      } else setNotice("設定を保存しました。再起動せず次の保存から使えます。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="notion-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <p>
        レビューの保存先を設定します。xangiと共通のAPI認証を使えます。Notionのブラウザログイン・MCPログインとは別の設定です。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <p>
        {settings
          ? settings.hasToken
            ? "認証キー：設定あり（値は表示しません）"
            : "認証キー：未設定"
          : "設定を読み込み中…"}
      </p>
      <label>
        保存先ページURLまたはID
        <input
          value={parent}
          onChange={(e) => setParent(e.target.value)}
          placeholder="https://www.notion.so/…"
          disabled={busy || !settings || settings.parentLocked}
          required
        />
      </label>
      {settings?.parentLocked && (
        <p>保存先は管理者の環境変数で固定されています。</p>
      )}
      <details>
        <summary>認証キーを設定・変更する</summary>
        <label>
          このxangi-studio専用のAPIキー
          <input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={
              busy || !settings || settings.tokenLocked || settings.parentLocked
            }
            maxLength={4096}
            placeholder="空欄なら既存の認証を維持"
          />
        </label>
        <small>
          サーバーに保存します。Notionの対象ページで、このキーの連携を「接続」に追加してください。
        </small>
      </details>
      <div className="notion-actions">
        <button
          type="submit"
          disabled={busy || !settings || settings.parentLocked}
        >
          {busy ? "処理中…" : "設定を保存"}
        </button>
        <button
          type="button"
          disabled={busy || !settings}
          onClick={() => void save(true)}
        >
          保存して接続確認
        </button>
      </div>
      <p className="settings-hint">
        接続確認はページの読み取りだけを行います。ページの作成や更新は行いません。
      </p>
    </form>
  );
}
export function NotionDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved?: (configured: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="notion-dialog"
      aria-labelledby="notion-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <header>
        <h2 id="notion-title">Notion保存設定</h2>
        <button type="button" onClick={onClose} aria-label="Notion設定を閉じる">
          閉じる
        </button>
      </header>
      <NotionSettings onSaved={onSaved} />
    </dialog>
  );
}
