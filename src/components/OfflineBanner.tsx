import { AlertTriangle, WifiOff } from "lucide-react";

import type { AirConnection } from "@/lib/connection-status";

const LEVEL_STYLE: Record<AirConnection["level"], string> = {
  info: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200",
  warn: "border-amber-500/50 bg-amber-500/12 text-amber-200",
  danger: "border-red-500/55 bg-red-500/14 text-red-200",
};

/**
 * Гучний банер стану звʼязку — зверху, над усім.
 *
 * Показується лише коли є що сказати (не «live»): застигла картина, затримка,
 * офлайн чи відсутність даних. Мовчить, поки все свіже, щоб не привчати ігнорувати
 * себе — тоді, коли він таки зʼявиться, на нього подивляться.
 */
export default function OfflineBanner({ conn }: { conn: AirConnection }) {
  if (!conn.banner) return null;
  const Offline = conn.link === "offline" || conn.link === "nodata";
  const Icon = Offline ? WifiOff : AlertTriangle;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-2 border-b px-3 py-2 font-mono text-[11px] leading-snug ${LEVEL_STYLE[conn.level]}`}
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${conn.level === "warn" ? "" : "animate-pulse"}`} />
      <div className="min-w-0">
        <span className="font-semibold uppercase tracking-[0.08em]">{conn.headline}</span>
        {conn.detail ? <span className="ml-1.5 opacity-90">{conn.detail}</span> : null}
      </div>
    </div>
  );
}
