import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArtifactList } from "./WorkspaceHome";
import { HostNavigation } from "./HostNavigation";
import { StudioHeader } from "./StudioHeader";
import "./artifact-layout.css";

export function ArtifactLayout({
  children,
  page,
  home = false,
  beforeNavigate = (action) => action(),
}: {
  children: ReactNode;
  page: "artifacts" | "import" | "settings";
  home?: boolean;
  beforeNavigate?: (action: () => void) => void;
}) {
  const compactQuery =
    "(max-width: 768px), (max-height: 500px) and (hover: none)";
  const [compact, setCompact] = useState(
    () => matchMedia(compactQuery).matches,
  );
  const [drawerOpen, setDrawerOpen] = useState(home);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("studio-sidebar-collapsed") === "true",
  );
  const listOpen = compact ? drawerOpen : !collapsed;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const closeList = () => {
    if (compact) setDrawerOpen(false);
    else setCollapsed(true);
    toggleRef.current?.focus();
  };
  useEffect(() => {
    const media = matchMedia(compactQuery);
    const update = () => {
      setCompact(media.matches);
      setDrawerOpen(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    localStorage.setItem("studio-sidebar-collapsed", String(collapsed));
  }, [collapsed]);
  useEffect(() => {
    if (!compact || !drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    asideRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, [compact, drawerOpen]);
  const navigate = (href: string) =>
    beforeNavigate(() => {
      location.href = href;
    });
  return (
    <div className="artifact-shell">
      <div className="artifact-topbar">
        <HostNavigation
          beforeHistory={beforeNavigate}
          onNavigate={(event) => {
            event.preventDefault();
            navigate(event.currentTarget.href);
          }}
        />
        <StudioHeader
          page={page}
          leading={
            <button
              ref={toggleRef}
              type="button"
              className="icon-button artifact-sidebar-toggle"
              aria-label={listOpen ? "サイドバーを閉じる" : "サイドバーを開く"}
              title={listOpen ? "サイドバーを閉じる" : "サイドバーを開く"}
              aria-expanded={listOpen}
              aria-controls="artifact-navigation"
              onClick={() =>
                compact ? setDrawerOpen(!drawerOpen) : setCollapsed(!collapsed)
              }
            >
              ☰
            </button>
          }
          onNavigate={(event, href) => {
            event.preventDefault();
            navigate(href);
          }}
        />
      </div>
      <div className="artifact-layout" data-list-open={listOpen}>
        <aside
          id="artifact-navigation"
          ref={asideRef}
          hidden={!listOpen}
          role={compact && listOpen ? "dialog" : undefined}
          aria-modal={compact && listOpen ? true : undefined}
          aria-label="成果物一覧"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeList();
            }
            if (compact && event.key === "Tab") {
              const controls = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  'a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]',
                ),
              ];
              const first = controls[0],
                last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <ArtifactList onNavigate={navigate} onClose={closeList} />
        </aside>
        <div className="artifact-detail">{children}</div>
      </div>
      {compact && listOpen && (
        <button
          className="artifact-scrim"
          type="button"
          aria-label="成果物一覧を閉じる"
          tabIndex={-1}
          onClick={closeList}
        />
      )}
    </div>
  );
}
