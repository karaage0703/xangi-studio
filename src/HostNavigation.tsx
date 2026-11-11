import { useEffect, useState, type MouseEventHandler } from "react";
import { HISTORY_EVENT, historyAvailability, goHistory } from "./appHistory";
import { isManagedExtension } from "./api";
import "./host-navigation.css";
export function HostNavigation({
  onNavigate,
  beforeHistory,
}: {
  onNavigate?: MouseEventHandler<HTMLAnchorElement>;
  beforeHistory?: (action: () => void) => void;
}) {
  const [available, setAvailable] = useState(historyAvailability);
  useEffect(() => {
    const update = () => setAvailable(historyAvailability());
    window.addEventListener(HISTORY_EVENT, update);
    return () => window.removeEventListener(HISTORY_EVENT, update);
  }, []);
  if (!isManagedExtension) return null;
  return (
    <nav className="xangi-host-nav" aria-label="xangi共通ナビゲーション">
      <button
        type="button"
        className="xangi-home-button"
        aria-label="戻る"
        disabled={!available.back}
        onClick={() =>
          beforeHistory ? beforeHistory(() => goHistory(-1)) : goHistory(-1)
        }
      >
        ←
      </button>
      <button
        type="button"
        className="xangi-home-button"
        aria-label="進む"
        disabled={!available.forward}
        onClick={() =>
          beforeHistory ? beforeHistory(() => goHistory(1)) : goHistory(1)
        }
      >
        →
      </button>
      <a
        className="xangi-home-button"
        href="/"
        aria-label="xangiホーム"
        title="xangiホーム"
        onClick={onNavigate}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
        </svg>
        <span>xangiホーム</span>
      </a>
    </nav>
  );
}
