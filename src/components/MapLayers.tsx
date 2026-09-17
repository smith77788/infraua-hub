import { useState } from "react";
import CollapsiblePanel from "./CollapsiblePanel";
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
  return (
    <CollapsiblePanel
      storageKey="layers"
      /*
       * Довідкова панель — згорнута завжди, поки людина не вирішить інакше.
       * Її відкривають, коли щось незрозуміло, а не тримають розгорнутою:
       * на відміну від хвиль і прогнозу, вона нічого не повідомляє про
       * ЗАРАЗ, тож місця на карті не варта навіть на широкому екрані.
       */
      defaultOpen={false}
      borderClass="border-border"
      textClass="text-muted-foreground"
      title={
        <>
          <Layers className="size-3 shrink-0" />
          Шари карти
        </>
      }
    >
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
    </CollapsiblePanel>
  );
}
