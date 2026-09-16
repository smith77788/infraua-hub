import { useMemo } from "react";

import type { Threat } from "@/lib/air";
import { hotOblasts } from "@/lib/hot-oblasts";

/**
 * «Найгарячіше зараз» — топ областей за кількістю повітряних цілей.
 *
 * Окремий компонент навмисно: обчислення чисте (групування за найближчим
 * обласним центром, як у каналі), а накладка на карту не чіпає решту розмітки —
 * менше шансів на конфлікт і на збій верстки. Порожнє небо → нічого не малюємо.
 *
 * Показуємо три області, але НІКОЛИ не мовчимо про решту: поруч стоїть
 * лічильник усіх цілей, і смуга, що показує частину без слова про це, змушує
 * читача думати, ніби числа на екрані не сходяться між собою.
 */
export default function HotOblasts({ threats }: { threats: Threat[] }): React.ReactElement | null {
  // Лічба — у `hot-oblasts.ts` і під тестами: саме в ній була вада, а не в стилях.
  const { top, restOblasts, restTargets } = useMemo(() => hotOblasts(threats), [threats]);

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
        {/*
          Скільки лишилось за кадром — вголос.
          
          Смуга показує топ-3 області й доти мовчала про решту. Поряд із
          лічильником «повітряні цілі 17» сума 4+4+3 читається як «це все», і
          саме так це й прочитали: числа на екрані не сходяться. Обрізка сама
          собою чесна — три області вміщаються, десять ні, — нечесним було
          мовчання про неї.
        */}
        {restOblasts > 0 ? (
          <span className="whitespace-nowrap opacity-70">
            <span className="mx-1 opacity-40">·</span>
            <span className="normal-case tracking-normal">
              ще {restOblasts} обл.{restTargets > 0 ? `, ${restTargets} ціл.` : ""}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
