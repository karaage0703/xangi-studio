import { useEffect, useRef, useState } from "react";
import { request } from "./api";

type Draft = { content: string; updatedAt: string };
type Status = "loading" | "saving" | "saved" | "failed";
type Session = {
  text: string;
  saved: string | null;
  ready: boolean;
  stopped: boolean;
  appliedRevision: number;
  key: string;
  backupKey: string;
  restoredBackup?: { key: string; value: string };
  timer?: ReturnType<typeof setTimeout>;
  initializing?: Promise<void>;
  pending?: Promise<void>;
};
function checkDraft(value: Draft | null) {
  if (value !== null && (!value || typeof value.content !== "string"))
    throw new Error("下書きを確認できません。本文は残しています。");
  return value;
}
export function useDraftAutosave({
  scope,
  id,
  initialContent,
  onRestore,
}: {
  scope: "review";
  id: string | null;
  initialContent: string;
  onRestore: (text: string) => void;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const current = useRef<Session | null>(null);
  const restore = useRef(onRestore);
  restore.current = onRestore;
  const notify = (s: Session, next: Status, message = "") => {
    if (current.current === s && !s.stopped) {
      setStatus(next);
      setError(message);
    }
  };
  const backup = (s: Session) => {
    try {
      localStorage.setItem(
        s.backupKey,
        JSON.stringify({ content: s.text, at: Date.now() }),
      );
    } catch {}
  };
  const clearBackup = (s: Session) => {
    try {
      localStorage.removeItem(s.backupKey);
      if (
        s.restoredBackup &&
        localStorage.getItem(s.restoredBackup.key) === s.restoredBackup.value
      )
        localStorage.removeItem(s.restoredBackup.key);
      s.restoredBackup = undefined;
    } catch {}
  };
  const flushSession = async (s: Session): Promise<void> => {
    clearTimeout(s.timer);
    await s.initializing;
    if (s.pending) return s.pending;
    s.pending = (async () => {
      while (s.text !== s.saved) {
        const content = s.text;
        const appliedRevision = s.appliedRevision;
        notify(s, "saving");
        try {
          const saved = checkDraft(
            await request<Draft>(s.key, {
              method: "PUT",
              signal: AbortSignal.timeout(15000),
              body: JSON.stringify({ content }),
            }),
          );
          if (!saved) throw new Error("下書きの保存結果を確認できません。");
          s.saved = content;
          if (s.text === content) clearBackup(s);
          else backup(s);
        } catch (e) {
          // A successful explicit file save supersedes an older draft request.
          if (appliedRevision !== s.appliedRevision) continue;
          backup(s);
          notify(s, "failed", (e as Error).message);
          throw e;
        }
      }
      notify(s, "saved");
    })().finally(() => {
      s.pending = undefined;
    });
    return s.pending;
  };
  useEffect(() => {
    if (!id) {
      current.current = null;
      return;
    }
    const prefix = `studio-draft:${location.pathname}:${scope}:${id}:`;
    const s: Session = {
      text: initialContent,
      saved: initialContent,
      ready: false,
      stopped: false,
      appliedRevision: 0,
      key: `/api/drafts/${scope}/${encodeURIComponent(id)}`,
      backupKey: prefix + crypto.randomUUID(),
    };
    current.current = s;
    notify(s, "loading");
    let local: { content: string; at: number } | undefined;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const value = localStorage.getItem(key)!;
        const b = JSON.parse(value);
        if (
          typeof b.content === "string" &&
          typeof b.at === "number" &&
          (!local || b.at > local.at)
        ) {
          local = b;
          s.restoredBackup = { key, value };
        }
      }
    } catch {}
    s.initializing = (async () => {
      let failure = "";
      try {
        const remote = checkDraft(
          await request<Draft | null>(s.key, {
            signal: AbortSignal.timeout(15000),
          }),
        );
        s.saved = remote?.content ?? initialContent;
        s.text = local?.content ?? s.saved;
      } catch (e) {
        s.text = local?.content ?? initialContent;
        s.saved = null;
        failure = (e as Error).message;
      }
      s.ready = true;
      if (current.current === s && !s.stopped) restore.current(s.text);
      notify(
        s,
        failure ? "failed" : s.text === s.saved ? "saved" : "saving",
        failure,
      );
    })();
    void s.initializing.then(() => {
      if (s.text !== s.saved && s.saved !== null)
        void flushSession(s).catch(() => {});
    });
    const leave = (e: BeforeUnloadEvent) => {
      if (s.text !== s.saved) {
        backup(s);
        void flushSession(s).catch(() => {});
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const focusOut = (event: FocusEvent) => {
      if (
        event.relatedTarget instanceof Element &&
        event.relatedTarget.closest(".draft-status-bar")
      )
        return;
      if (s.ready && s.text !== s.saved) void flushSession(s).catch(() => {});
    };
    const keys = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flushSession(s).catch(() => {});
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden")
        void flushSession(s).catch(() => {});
    };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("focusout", focusOut);
    window.addEventListener("keydown", keys);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      s.stopped = true;
      clearTimeout(s.timer);
      if (s.text !== s.saved) backup(s);
      void flushSession(s).catch(() => {});
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("focusout", focusOut);
      window.removeEventListener("keydown", keys);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [scope, id]);
  const update = (text: string) => {
    const s = current.current;
    if (!s) return;
    s.text = text;
    backup(s);
    restore.current(text);
    notify(s, "saving");
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void flushSession(s).catch(() => {}), 800);
  };
  const flush = async () => {
    if (current.current) await flushSession(current.current);
  };
  const applied = (text: string) => {
    const s = current.current;
    if (!s) return;
    clearTimeout(s.timer);
    s.appliedRevision++;
    s.text = text;
    s.saved = text;
    clearBackup(s);
    restore.current(text);
    notify(s, "saved");
  };
  return {
    status,
    error,
    update,
    flush,
    applied,
    retry: () => void flush().catch(() => {}),
    ready:
      !!id &&
      !!current.current?.ready &&
      current.current.key ===
        `/api/drafts/${scope}/${encodeURIComponent(id)}` &&
      status !== "loading",
    pending: status !== "saved",
  };
}
