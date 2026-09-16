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
    <div className="pointer-events-auto w-52 max-w-[80vw] rounded border border-border bg-background/95 p-2 backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Шари карти
        </span>
        <button
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="space-y-1">
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
