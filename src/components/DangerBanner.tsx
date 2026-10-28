import { AlertTriangle, ChevronDown, EyeOff } from "lucide-react";
import { useState } from "react";

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
  /*
   * На телефоні пояснення «чому карта може бути порожньою» згорнуте до одного
   * рядка: розгорнутий банер займав чверть екрана й зсував карту (знімок
   * користувача, 28.10). Заголовок і рівень — завжди видно; пояснення —
   * одним дотиком. На широкому екрані — як було, розгорнуто.
   */
  const [open, setOpen] = useState(false);
  if (notice.level === "none") return null;
  const danger = notice.level === "danger";
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`shrink-0 border-b px-3 py-1.5 text-[13px] leading-snug sm:py-2 ${
        danger
          ? "border-red-500/55 bg-red-500/14 text-red-200"
          : "border-amber-500/50 bg-amber-500/12 text-amber-200"
      }`}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${danger ? "animate-pulse" : ""}`} />
        <div className="line-clamp-2 min-w-0 sm:line-clamp-none">
          <span className="font-semibold">{notice.headline}</span>
          {notice.reasons.length > 0 ? (
            <span className="ml-1.5 opacity-90">{notice.reasons.join(" · ")}</span>
          ) : null}
          <span className="ml-1.5 hidden opacity-60 sm:inline">— оголошено офіційно</span>
          {/*
           * Число цілей поруч із попередженням, а не лише на карті: саме
           * розрив між «оголошено» і «у фіді нуль» людина читає як «тихо»,
           * коли бачить порожню карту й не має із чим її зіставити.
           */}
          {notice.hereCount !== null ? (
            <span className="ml-1.5 opacity-60">· цілей у фіді тут: {notice.hereCount}</span>
          ) : null}
        </div>
      </div>
      {notice.blindTo ? (
        <div className="mt-1.5 border-t border-current/20 pt-1.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex w-full items-start gap-2 text-left sm:pointer-events-none"
          >
            <EyeOff className="mt-0.5 size-4 shrink-0 opacity-80" />
            <span
              className={`min-w-0 flex-1 opacity-90 ${open ? "" : "line-clamp-1 sm:line-clamp-none"}`}
            >
              {notice.blindTo}
            </span>
            <ChevronDown
              className={`mt-0.5 size-4 shrink-0 opacity-70 transition-transform sm:hidden ${open ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      ) : null}
    </div>
  );
}
