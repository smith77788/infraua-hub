import { useEffect, useRef, useState } from "react";
import { Pause, Play, Radio, RotateCcw } from "lucide-react";

const SPAN_MS = 30 * 864e5; // 30 днів
const TRAIL_MS = 3 * 864e5; // видиме вікно позаду курсора
const STEP_MS = 6 * 3600_000; // крок відтворення
const TICK = 420; // мс між кроками

interface Props {
  /** Викликається зі значенням правої межі курсора (ms) або null у «живому» режимі. */
  onCursor: (cursorMs: number | null) => void;
}

/**
 * Плеєр часу: прокручує курсор по 30-денному вікну та анімує розвиток подій.
 *
 * «Зараз» береться після відкриття сторінки, а не під час першого малювання.
 * Сторінка збирається на сервері й довершується в браузері; `Date.now()` у
 * тілі компонента дає там і там різні значення, розмітка розходиться, і React
 * перемальовує гілку з помилкою в консолі. Такий збій легко не помітити —
 * виглядає все правильно, — тому час свідомо зʼявляється лише в браузері, а до
 * того плеєр показує себе неактивним.
 */
export default function TimelinePlayer({ onCursor }: Props) {
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);
  const min = (nowMs ?? 0) - SPAN_MS;
  const [cursor, setCursor] = useState<number | null>(null); // null = live
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    onCursor(cursor);
  }, [cursor, onCursor]);

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setCursor((c) => {
        const next = (c ?? min) + STEP_MS;
        if (nowMs === null || next >= nowMs) {
          setPlaying(false);
          return null; // повертаємось у живий режим
        }
        return next;
      });
    }, TICK);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, min, nowMs]);

  const live = cursor === null;
  const value = cursor ?? nowMs ?? 0;
  const label = live
    ? "Живий режим"
    : new Date(cursor).toLocaleString("uk-UA", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-[500] flex items-center gap-2 border-t border-border bg-background/92 px-3 py-2 backdrop-blur">
      <button
        onClick={() => {
          if (live) setCursor(min + TRAIL_MS);
          setPlaying((p) => !p);
        }}
        className="flex size-7 shrink-0 items-center justify-center rounded border border-border text-foreground transition-colors hover:bg-card"
        title={playing ? "Пауза" : "Відтворити"}
      >
        {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      </button>

      <button
        onClick={() => {
          setPlaying(false);
          setCursor(null);
        }}
        className={`flex size-7 shrink-0 items-center justify-center rounded border transition-colors ${
          live
            ? "border-primary/60 text-primary"
            : "border-border text-muted-foreground hover:bg-card"
        }`}
        title="Живий режим"
      >
        {live ? <Radio className="size-3.5" /> : <RotateCcw className="size-3.5" />}
      </button>

      <input
        type="range"
        min={min}
        max={nowMs ?? 0}
        step={STEP_MS}
        value={value}
        // До того, як зʼявиться час, тягнути нема за що: діапазон порожній.
        disabled={nowMs === null}
        onChange={(e) => {
          const v = Number(e.target.value);
          setPlaying(false);
          setCursor(nowMs !== null && v >= nowMs ? null : v);
        }}
        className="h-1 flex-1 cursor-pointer accent-primary disabled:cursor-default disabled:opacity-40"
      />

      <span className="w-32 shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

export { TRAIL_MS };
