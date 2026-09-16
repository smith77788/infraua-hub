import { useState } from "react";
import MapPanel from "./MapPanel";
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
  /*
   * `w-60 max-w-full`, а не частка від екрана: на 320 px під легенду лишалось
   * 202 px (решту зʼїдають кути з кнопками Leaflet), а «80vw» дозволяло 256 —
   * і панель заходила просто на перемикач підкладки. Межу задає те місце, куди
   * панель кладуть, а не здогад про ширину телефона.
   */
  return (
    <MapPanel
      id="legend"
      title="Легенда карти"
      short="Легенда"
      icon={HelpCircle}
      className="w-60 max-w-full"
    >
      <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
        Повітряні цілі (за типом)
      </p>
      <div className="mb-2 grid grid-cols-1 gap-1">
        {AIR_TYPES.map((t) => (
          <div key={t.label} className="flex items-center gap-2 text-[11px]">
            <Swatch color={t.color} /> {t.label}
          </div>
        ))}
        {/*
          Легенда мусить пояснювати те, чого не видно з вигляду. Коло довкола
          цілі й густота пунктиру — не оформлення, а два різні твердження про
          те, наскільки джерело впевнене; людина, яка прочитає їх як прикрасу,
          повірить позначці більше, ніж варто.
        */}
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          Яскравість = свіжість (свіжі пульсують). Тип визначається з тексту OSINT-каналів; «—» —
          тип невідомий.
        </p>
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          <b className="text-foreground">Коло довкола цілі</b> — розкид позиції, як його називає
          джерело (суцільний контур) або наша обережна оцінка, коли джерело змовчало (пунктирний).
          Ціль — десь у цьому колі, а не в його центрі.
        </p>
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          <b className="text-foreground">Лінія від цілі</b> — курс: густий пунктир, коли його
          спостерігали, рідкий і блідий — коли джерело його лише припускає. Суцільна лінія — трек,
          тобто де ціль була насправді.
        </p>
      </div>

      <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
        Шари
      </p>
      <div className="grid grid-cols-1 gap-1 text-[11px]">
        <div className="flex items-center gap-2">
          <Swatch color="#34d399" /> Укриття: метро, обладнані сховища, підземні паркінги
        </div>
        <p className="-mt-0.5 mb-1 text-[10px] leading-snug text-muted-foreground">
          Не державний реєстр — лише те, що розмічено на відкритій карті. Поруч може бути ближче
          укриття, якого тут немає.
        </p>
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
    </MapPanel>
  );
}
