import type { MouseEvent, ReactNode } from "react";
import { workspacePath } from "./api";

type Page = "artifacts" | "import" | "settings";

export function StudioHeader({
  page,
  onNavigate,
  children,
  leading,
}: {
  page: Page;
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
  children?: ReactNode;
  leading?: ReactNode;
}) {
  const links: { page: Page; href: string; label: string }[] = [
    {
      page: "artifacts",
      href: workspacePath,
      label: "成果物",
    },
    { page: "settings", href: `${workspacePath}?settings=1`, label: "設定" },
  ];
  const navigate = (event: MouseEvent<HTMLAnchorElement>, href: string) =>
    onNavigate?.(event, href);
  return (
    <header className="app-header studio-topbar">
      {leading}
      <a
        className="studio-brand"
        href={workspacePath}
        onClick={(event) => navigate(event, workspacePath)}
      >
        <span aria-hidden="true" className="studio-brand-mark">
          x
        </span>
        <span>xangi-studio</span>
      </a>
      <nav className="studio-primary-nav" aria-label="xangi-studioの画面">
        {links.map((link) => (
          <a
            key={link.page}
            href={link.href}
            aria-current={page === link.page ? "page" : undefined}
            onClick={(event) => navigate(event, link.href)}
          >
            {link.label}
          </a>
        ))}
      </nav>
      {children && <div className="studio-header-actions">{children}</div>}
    </header>
  );
}
