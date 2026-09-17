import { useState } from "react";

import type { RaidFrame } from "@/lib/raid-replay";
import RaidReplay from "./RaidReplay";
import TimelinePlayer from "./TimelinePlayer";

interface Props {
  frames: readonly RaidFrame[];
  onRaidCursor: (cursorMs: number | null) => void;
  onHistoryCursor: (cursorMs: number | null) => void;
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
export default function TimeScrubbers({ frames, onRaidCursor, onHistoryCursor }: Props) {
  const [mode, setMode] = useState<Mode>("raid");

  const switchTo = (m: Mode) => {
    if (m === mode) return;
    // Лишаємо активним лише новий режим — інший повертаємо «наживо».
    if (m === "raid") onHistoryCursor(null);
    else onRaidCursor(null);
    setMode(m);
  };

  return (
    <div className="pointer-events-auto border-t border-border/70 bg-background/88 backdrop-blur">
      <div className="flex items-center gap-1 px-3 pt-1.5">
        {(["raid", "history"] as const).map((m) => (
          <button
            key={m}
            onClick={() => switchTo(m)}
            className={`rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors ${
              mode === m
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-card hover:text-foreground"
            }`}
            title={m === "raid" ? "Перемотка нальоту (хвилини)" : "Перемотка ударів (30 днів)"}
          >
            {m === "raid" ? "Наліт" : "Історія"}
          </button>
        ))}
      </div>
      {mode === "raid" ? (
        <RaidReplay frames={frames} onCursor={onRaidCursor} hideLabel />
      ) : (
        <TimelinePlayer onCursor={onHistoryCursor} hideLabel />
      )}
    </div>
  );
}
