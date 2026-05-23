import { FolderOpen, Trash2 } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";

export function NavSidebar() {
  const { t } = useTranslation();

  return (
    <aside className="w-[200px] flex-shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/60 py-3 px-2">
      <NavItem to="/projects" icon={<FolderOpen size={15} />} label={t("nav.localProjects")} />
      <NavItem to="/trash" icon={<Trash2 size={15} />} label={t("nav.trash")} />
    </aside>
  );
}

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
}

export function NavItem({ to, icon, label }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        clsx(
          "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
          isActive
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
        )
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
