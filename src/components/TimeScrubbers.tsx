import { useState } from "react";

import type { RaidFrame } from "@/lib/raid-replay";
import RaidReplay from "./RaidReplay";

interface Props {
  frames: readonly RaidFrame[];
  /** Кадри за добу — для «Історії» (довантажуються, коли її відкрили). */
  historyFrames: readonly RaidFrame[];
  onRaidCursor: (cursorMs: number | null) => void;
  onHistoryCursor: (cursorMs: number | null) => void;
  /** Людина відкрила «Історію» — час довантажити добу кадрів. */
  onHistoryOpen?: () => void;
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
  historyFrames,
  onRaidCursor,
  onHistoryCursor,
  onHistoryOpen,
}: Props) {
  const [mode, setMode] = useState<Mode>("raid");

  const switchTo = (m: Mode) => {
    if (m === mode) return;
    // Лишаємо активним лише новий режим — інший повертаємо «наживо».
    if (m === "raid") onHistoryCursor(null);
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
            title={m === "raid" ? "Повтор нальоту: останні 3 години" : "Історія нальотів за добу"}
          >
            {m === "raid" ? "Наліт" : "Історія"}
          </button>
        ))}
      </div>
      {mode === "raid" ? (
        <RaidReplay frames={frames} onCursor={onRaidCursor} hideLabel />
      ) : (
        /*
         * «Історія» — нальоти за добу, на тій самій карті. Досі тут була
         * перемотка стрічки подій за 30 днів: вона порожня, тож повзунок
         * рухався, а карта стояла (знімок користувача, 29.10).
         */
        <RaidReplay frames={historyFrames} onCursor={onHistoryCursor} hideLabel />
      )}
    </div>
  );
}
