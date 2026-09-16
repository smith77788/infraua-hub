import { useState } from "react";
import { Layers, X } from "lucide-react";

/*
 * Контрол шарів прямо на карті. У бічній панелі перемикачі шарів на мобільному
 * опиняються під картою — недосяжні під час перегляду карти. Цей компактний
 * контрол дублює головні шари-оверлеї там, де вони й потрібні: на самій карті.
 */

export interface LayerToggle {
  key: string;
  label: string;
  active: boolean;
  disabled?: boolean;
  color: string;
}

export default function MapLayers({
  layers,
  onToggle,
}: {
  layers: LayerToggle[];
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Шари карти"
        aria-label="Шари карти"
        className="pointer-events-auto flex items-center gap-1.5 rounded border border-border bg-background/90 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
      >
        <Layers className="size-3.5" /> <span className="hidden sm:inline">Шари</span>
      </button>
    );
  }

  return (
    // max-h-full + власна прокрутка: на невисокій карті мініапу відкритий список
    // шарів інакше вивалювався вниз і накривав легенду та смугу гарячих
    // областей. Тепер він обмежений своєю смугою і гортається всередині.
    <div className="pointer-events-auto flex max-h-full w-52 max-w-[80vw] flex-col overflow-hidden rounded border border-border bg-background/95 backdrop-blur">
      {/*
        Шапка липка: коли список довший за смугу й гортається, хрестик «закрити»
        має лишатися на видноті, а не їхати вгору під кнопки зуму.
      */}
      <div className="sticky top-0 flex items-center justify-between border-b border-border/60 bg-background/95 px-2 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Шари карти
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label="Закрити"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {layers.map((l) => (
          <button
            key={l.key}
            onClick={() => onToggle(l.key)}
            disabled={l.disabled}
            className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition-colors disabled:opacity-40 ${
              l.active ? "border-border bg-card" : "border-transparent bg-transparent opacity-60"
            }`}
          >
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{
                background: l.active ? l.color : "transparent",
                boxShadow: `0 0 0 1px ${l.color}`,
              }}
            />
            <span className="min-w-0 flex-1 truncate">{l.label}</span>
            <span
              className={`shrink-0 font-mono text-[9px] uppercase ${l.active ? "text-primary" : "text-muted-foreground"}`}
            >
              {l.active ? "увімк" : "вимк"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
