import { useEffect, useRef, useState } from "react";
import { Pause, Play, Radio } from "lucide-react";

import { type RaidFrame, replaySpan } from "@/lib/raid-replay";

interface Props {
  /** Кільцевий буфер знімків повітряної картини (накопичується в браузері). */
  frames: readonly RaidFrame[];
  /** Права межа курсора (ms) під час перемотки, або null у «живому» режимі. */
  onCursor: (cursorMs: number | null) => void;
}

// Увесь буфер стискаємо приблизно в 15 с відтворення, незалежно від його
// тривалості: наліт на годину і наліт на 10 хв обидва «прокручуються» плавно.
const STEPS = 60;
const TICK = 250;

/**
 * Реплей нальоту: перемотка ЖИВОЇ повітряної картини, накопиченої з моменту
 * відкриття вкладки. Показуємо смугу лише коли є що перемотувати (≥2 кадри) —
 * у спокійному небі її немає взагалі, тож вона не захаращує інтерфейс і
 * зʼявляється рівно тоді, коли оператору треба побачити, як зайшов рій.
 *
 * Курсор віддаємо назовні; сторінка підміняє масив цілей на кадр цього моменту,
 * а сама карта вже вміє малювати з нього спостережений трек.
 */
export default function RaidReplay({ frames, onCursor }: Props) {
  const span = replaySpan(frames);
  const [cursor, setCursor] = useState<number | null>(null); // null = наживо
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Курс назовні — синхронно зі зміною курсора.
  useEffect(() => {
    onCursor(cursor);
  }, [cursor, onCursor]);

  // Буфер спорожнів або зʼявився заново — не лишаємо курсор висіти в минулому.
  useEffect(() => {
    if (!span) {
      setPlaying(false);
      setCursor(null);
    }
  }, [span]);

  useEffect(() => {
    if (!playing || !span) return;
    const step = Math.max(1, (span.to - span.from) / STEPS);
    timer.current = setInterval(() => {
      setCursor((c) => {
        const next = (c ?? span.from) + step;
        if (next >= span.to) {
          setPlaying(false);
          return null; // дійшли до кінця — повертаємось наживо
        }
        return next;
      });
    }, TICK);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, span]);

  if (!span) return null;

  const live = cursor === null;
  const value = cursor ?? span.to;
  const label = live
    ? "Наживо"
    : new Date(cursor).toLocaleTimeString("uk-UA", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-[46px] z-[500] flex items-center gap-2 border-t border-border/70 bg-background/88 px-3 py-1.5 backdrop-blur">
      <span className="hidden shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-primary/80 sm:inline">
        Реплей нальоту
      </span>
      <button
        onClick={() => {
          if (live) setCursor(span.from);
          setPlaying((p) => !p);
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded border border-border text-foreground transition-colors hover:bg-card"
        title={playing ? "Пауза" : "Відтворити наліт"}
      >
        {playing ? <Pause className="size-3" /> : <Play className="size-3" />}
      </button>

      <button
        onClick={() => {
          setPlaying(false);
          setCursor(null);
        }}
        className={`flex size-6 shrink-0 items-center justify-center rounded border transition-colors ${
          live
            ? "border-primary/60 text-primary"
            : "border-border text-muted-foreground hover:bg-card"
        }`}
        title="Наживо"
      >
        <Radio className="size-3" />
      </button>

      <input
        type="range"
        min={span.from}
        max={span.to}
        step={Math.max(1, (span.to - span.from) / STEPS)}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          setPlaying(false);
          setCursor(v >= span.to ? null : v);
        }}
        className="h-1 flex-1 cursor-pointer accent-primary"
      />

      <span className="w-16 shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
