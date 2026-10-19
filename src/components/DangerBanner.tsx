import { AlertTriangle, EyeOff } from "lucide-react";

import type { DangerNotice } from "@/lib/danger-notice";

/**
 * Офіційне попередження про небезпеку — і межа того, що ми бачимо.
 *
 * Стоїть угорі, над усім, бо виник після випадку, коли в місті людини
 * пролунали вибухи, офіційно діяв підвищений рівень небезпеки, а консоль не
 * сказала нічого: рівень тривоги фарбував полігон на карті й ніде більше не
 * зʼявлявся.
 *
 * Другий рядок (`blindTo`) важливіший за перший. Коли офіційно оголошено
 * ракетну небезпеку, а наш фід ракет не бачить, порожня карта читається як
 * «тихо». Це найнебезпечніше прочитання, яке ця консоль може породити, і
 * мовчати про нього не можна.
 */
export default function DangerBanner({ notice }: { notice: DangerNotice }) {
  if (notice.level === "none") return null;
  const danger = notice.level === "danger";
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`border-b px-3 py-2 font-mono text-[11px] leading-snug ${
        danger
          ? "border-red-500/55 bg-red-500/14 text-red-200"
          : "border-amber-500/50 bg-amber-500/12 text-amber-200"
      }`}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${danger ? "animate-pulse" : ""}`} />
        <div className="min-w-0">
          <span className="font-semibold uppercase tracking-[0.08em]">{notice.headline}</span>
          {notice.reasons.length > 0 ? (
            <span className="ml-1.5 opacity-90">{notice.reasons.join(" · ")}</span>
          ) : null}
          <span className="ml-1.5 opacity-60">— оголошено офіційно</span>
        </div>
      </div>
      {notice.blindTo ? (
        <div className="mt-1.5 flex items-start gap-2 border-t border-current/20 pt-1.5">
          <EyeOff className="mt-0.5 size-4 shrink-0 opacity-80" />
          <span className="min-w-0 opacity-90">{notice.blindTo}</span>
        </div>
      ) : null}
    </div>
  );
}
