import { useState } from "react";

import type { RaidFrame } from "@/lib/raid-replay";
import RaidReplay from "./RaidReplay";

interface Props {
  frames: readonly RaidFrame[];
  onRaidCursor: (cursorMs: number | null) => void;
  /** Ночі, за які є треки (ключ — дата за Києвом, коли ніч почалась). */
  nights: readonly string[];
  /** Обрана ніч; `null` — «Історію» закрито, карта наживо. */
  night: string | null;
  /** Скільки цілей в обраній ночі — `null`, поки вантажиться. */
  nightTargets: number | null;
  onNight: (night: string | null) => void;
  /** Людина відкрила «Історію» — час довантажити перелік ночей. */
  onHistoryOpen?: () => void;
}

const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
/** «ніч на 1 лис»: ключ — дата початку ночі, а людина памʼятає ранок. */
function nightLabel(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `ніч на ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

type Mode = "raid" | "history";

/**
 * ОДИН часовий скрабер замість двох.
 *
 * Раніше «Наліт» (перемотка повітряної картини за хвилини) і «Історія»
 * (перемотка ударів за 30 днів) стояли двома однаковими рядами — кнопка, радіо,
 * повзунок — і читались як дубль, хоч керують РІЗНИМИ шарами. Тепер це один
 * блок із перемикачем режиму: у кожен момент активний лише один, тож дві
 * перемотки не воюють за карту, а плутанини «навіщо їх два» немає.
 */
export default function TimeScrubbers({
  frames,
  onRaidCursor,
  nights,
  night,
  nightTargets,
  onNight,
  onHistoryOpen,
}: Props) {
  const [mode, setMode] = useState<Mode>("raid");

  const switchTo = (m: Mode) => {
    if (m === mode) return;
    // Лишаємо активним лише новий режим — інший повертаємо «наживо».
    if (m === "raid") onNight(null);
    else {
      onRaidCursor(null);
      onHistoryOpen?.();
    }
    setMode(m);
  };

  return (
    <div className="pointer-events-auto border-t border-border/70 bg-background/88 backdrop-blur">
      <div className="flex items-center gap-1 px-3 pt-1.5">
        {(["raid", "history"] as const).map((m) => (
          <button
            key={m}
            onClick={() => switchTo(m)}
            className={`rounded px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors ${
              mode === m
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-card hover:text-foreground"
            }`}
            title={
              m === "raid" ? "Повтор нальоту: останні 3 години" : "Усі треки ночі на одній картинці"
            }
          >
            {m === "raid" ? "Наліт" : "Історія"}
          </button>
        ))}
      </div>
      {mode === "raid" ? (
        <RaidReplay frames={frames} onCursor={onRaidCursor} hideLabel />
      ) : (
        /*
         * «Історія» — усі треки ночі однією картинкою, за 30 ночей
         * (опитувальник 01.11). Ніч обирається стрічкою дат; карта показує
         * треки замість живих цілей, поки «Історію» не закрито.
         */
        <div className="flex min-w-0 items-center gap-2 px-3 pb-2 pt-1">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {nights.length === 0 ? (
              <span className="text-[12px] text-muted-foreground">Завантаження ночей…</span>
            ) : (
              nights.map((n) => (
                <button
                  key={n}
                  onClick={() => onNight(n)}
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[12px] tabular-nums transition-colors ${
                    night === n
                      ? "border-primary/60 bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {nightLabel(n)}
                </button>
              ))
            )}
          </div>
          <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
            {night === null ? "" : nightTargets === null ? "…" : `${nightTargets} цілей`}
          </span>
        </div>
      )}
    </div>
  );
}
