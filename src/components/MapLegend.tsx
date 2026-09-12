import { useState } from "react";
import { HelpCircle, X } from "lucide-react";

/*
 * Легенда карти. На карті багато шарів і типів позначок (типізовані повітряні
 * цілі, лінія фронту, пожежі, обʼєкти під загрозою) — без легенди читати їх
 * важко. Компактна, згортається; типово згорнута, щоб не заважати.
 */

const AIR_TYPES: { color: string; label: string }[] = [
  { color: "#ffd23f", label: "Ударний БпЛА" },
  { color: "#ff8c1a", label: "Реактивний БпЛА" },
  { color: "#ff6a2a", label: "Крилата ракета" },
  { color: "#ff4d4d", label: "Ракета" },
  { color: "#ff2d2d", label: "Балістика" },
  { color: "#ffb020", label: "КАБ" },
  { color: "#22d3ee", label: "Розвід. БпЛА" },
  { color: "#38bdf8", label: "Авіація" },
];

function Swatch({ color, shape = "tri" }: { color: string; shape?: "tri" | "dot" | "line" }) {
  if (shape === "line")
    return (
      <span
        className="inline-block h-0 w-4 border-t-2 border-dashed"
        style={{ borderColor: color }}
      />
    );
  if (shape === "dot")
    return <span className="inline-block size-2.5 rounded-full" style={{ background: color }} />;
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill={color} stroke="#0a0e14" strokeWidth="1.1">
      <path d="M12 3l7 16-7-3.6L5 19z" />
    </svg>
  );
}

/**
 * `showInfra` прибирає з легенди позначки обʼєктів інфраструктури разом із
 * самими обʼєктами: легенда, що пояснює позначку, якої на карті не буває, —
 * це опис іншої карти.
 */
export default function MapLegend({ showInfra = true }: { showInfra?: boolean }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-14 left-3 z-[500] flex items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
      >
        <HelpCircle className="size-3.5" /> Легенда
      </button>
    );
  }

  return (
    <div className="absolute bottom-14 left-3 z-[500] max-h-[70svh] w-60 overflow-y-auto rounded border border-border bg-background/95 p-3 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Легенда карти
        </span>
        <button
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
        Повітряні цілі (за типом)
      </p>
      <div className="mb-2 grid grid-cols-1 gap-1">
        {AIR_TYPES.map((t) => (
          <div key={t.label} className="flex items-center gap-2 text-[11px]">
            <Swatch color={t.color} /> {t.label}
          </div>
        ))}
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          Яскравість = свіжість (свіжі пульсують). Пунктир від цілі — курс. Тип визначається з
          тексту OSINT-каналів; «—» — тип невідомий.
        </p>
      </div>

      <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
        Шари
      </p>
      <div className="grid grid-cols-1 gap-1 text-[11px]">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-4 rounded-[2px] border"
            style={{ background: "#4a1b24", borderColor: "#9c5561" }}
          />{" "}
          Окупована територія (DeepState)
        </div>
        <div className="flex items-center gap-2">
          <Swatch color="#ff3b30" shape="dot" /> Пожежі (FIRMS, за FRP)
        </div>
        <div className="flex items-center gap-2">
          <Swatch color="#ff4d4d" shape="line" /> Зони повітряної тривоги (пунктир)
        </div>
        {showInfra ? (
          <>
            <div className="flex items-center gap-2">
              <span className="inline-block size-2.5 rounded-full ring-2 ring-red-500" /> Обʼєкт під
              загрозою
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block size-2.5 rounded-full bg-cyan-400" /> Кластер обʼєктів
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
