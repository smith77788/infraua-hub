import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Circle,
  FileStack,
  Folders,
  Globe2,
  LayoutDashboard,
  LogOut,
  Radar,
  ScrollText,
  Search,
  Share2,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/console/components/primitives";
import { ClearanceBadge } from "@/console/components/ClearanceBadge";
import { useSession } from "@/console/hooks/useSession";
import { api } from "@/console/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Огляд", icon: LayoutDashboard, exact: true },
  { to: "/investigate", label: "Розслідування", icon: Search, exact: false },
  { to: "/graph", label: "Граф", icon: Share2, exact: false },
  { to: "/analysis", label: "Аналіз", icon: Radar, exact: false },
  { to: "/map", label: "Мапа", icon: Globe2, exact: false },
  { to: "/cases", label: "Справи", icon: Folders, exact: false },
  { to: "/ingest", label: "Завантаження", icon: FileStack, exact: false },
  { to: "/audit", label: "Аудит", icon: ScrollText, exact: false },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { clearance, signOut } = useSession();

  // Liveness is a public endpoint, so this keeps reporting even after a key is
  // revoked — which is exactly when you want to know whether the API is up.
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 30_000,
    retry: false,
  });

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
        <Link
          to="/"
          className="flex items-center gap-2.5 px-4 py-4 transition-opacity hover:opacity-80"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">Palanter</p>
            <p className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
              Консоль аналітика
            </p>
          </div>
        </Link>

        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map(({ to, label, icon: Icon, exact }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact }}
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
              activeProps={{ className: "bg-secondary font-medium text-foreground" }}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="space-y-2 border-t border-border px-3 py-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Circle
              className={cn(
                "h-2 w-2 shrink-0",
                health.isSuccess
                  ? "fill-clearance-public text-clearance-public"
                  : "fill-destructive text-destructive",
              )}
            />
            <span className="truncate">
              {health.isSuccess
                ? "API онлайн"
                : health.isLoading
                  ? "Перевірка…"
                  : "API недоступний"}
            </span>
          </div>
          {health.data && (
            <p
              className="truncate text-[11px] text-muted-foreground"
              title={health.data.narrative_engine}
            >
              <Activity className="mr-1 inline h-3 w-3" />
              {health.data.narrative_engine}
            </p>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur md:px-6">
          <nav className="flex items-center gap-1 overflow-x-auto md:hidden">
            {NAV.map(({ to, label, icon: Icon, exact }) => (
              <Link
                key={to}
                to={to}
                activeOptions={{ exact }}
                title={label}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors"
                activeProps={{ className: "bg-secondary text-foreground" }}
              >
                <Icon className="h-4 w-4" />
              </Link>
            ))}
          </nav>
          <div className="hidden md:block" />

          <div className="flex items-center gap-2">
            {clearance !== null && (
              <div className="flex items-center gap-1.5">
                <span className="hidden text-[11px] uppercase tracking-wider text-muted-foreground sm:inline">
                  Допуск
                </span>
                <ClearanceBadge level={clearance} showIcon />
              </div>
            )}
            <Button variant="ghost" size="icon" onClick={signOut} title="Вийти" aria-label="Вийти">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 md:px-6 md:py-6">{children}</main>
      </div>
    </div>
  );
}
