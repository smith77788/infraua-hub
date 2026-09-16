import { useMemo } from "react";

import type { Threat } from "@/lib/air";
import { oblastOf } from "@/lib/channel-post";

/**
 * «Найгарячіше зараз» — топ областей за кількістю повітряних цілей.
 *
 * Окремий компонент навмисно: обчислення чисте (групування за найближчим
 * обласним центром, як у каналі), а накладка на карту не чіпає решту розмітки —
 * менше шансів на конфлікт і на збій верстки. Порожнє небо → нічого не малюємо.
 */
export default function HotOblasts({ threats }: { threats: Threat[] }): React.ReactElement | null {
  const top = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of threats) {
      const o = oblastOf(t.lat, t.lon);
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3);
  }, [threats]);

  if (top.length === 0) return null;

  return (
    <div className="pointer-events-none max-w-full">
      {/*
        Переносимо рядками, а не ріжемо: «Херсонщина 2», обрізана до «Херсо…», —
        це мовчазна втрата саме тієї області, яку людина шукала. Рядок нижче
        коштує кілька пікселів, обрізка коштує змісту.
      */}
      <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-2xl border border-amber-500/40 bg-background/90 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-300 shadow-lg backdrop-blur">
        <span className="text-amber-400">🔥</span>
        {top.map(([name, n], i) => (
          <span key={name} className="whitespace-nowrap">
            {i > 0 ? <span className="mx-1 opacity-40">·</span> : null}
            {name} <span className="text-foreground">{n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
