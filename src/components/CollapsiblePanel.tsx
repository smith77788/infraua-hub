import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Згортна накладка над картою.
 *
 * Карта — головне на екрані, а панелі (хвилі, прогноз руху) — довідка поверх
 * неї. Коли їх кілька й вони розгорнуті, від карти лишається щілина: сенс
 * радара — бачити небо, а не читати два блоки, що його закрили. Тому накладки
 * тепер згорнуті за замовчуванням до компактного чипа з головним числом, і
 * розгортаються дотиком. Вибір памʼятається (localStorage) — хто любить бачити
 * панель відкритою, більше не згортає її щоразу.
 *
 * Заголовок (`title`) показується ЗАВЖДИ й тому має нести суть уже згорнутим:
 * «Хвиль: 5», «Рій → ПнЗх». Тіло (`children`) — лише коли розгорнуто.
 *
 * ## Усталене залежить від ширини екрана
 *
 * На телефоні дві розгорнуті панелі не лишають від карти нічого — там місце
 * найдорожче, тож усталене «згорнуто». На широкому екрані місця вистачає, і
 * панель, згорнута без потреби, лише ховає те, заради чого її писали. Одне
 * стале значення на обидва випадки буде неправильним в одному з них.
 *
 * Збережений вибір людини важливіший за будь-яке усталене: щойно вона сама
 * згорнула чи розгорнула панель, ширина екрана більше нічого не вирішує.
 */
/** Ширина, з якої панелі відкриті одразу. Нижче — карта дорожча за довідку. */
const WIDE_PX = 640;

export default function CollapsiblePanel({
  title,
  children,
  storageKey,
  borderClass,
  textClass,
  defaultOpen,
}: {
  title: ReactNode;
  children: ReactNode;
  /** Ключ для памʼяті стану; різні панелі — різні ключі. */
  storageKey: string;
  /** Клас рамки, напр. "border-orange-500/40". */
  borderClass: string;
  /** Клас кольору заголовка, напр. "text-orange-300". */
  textClass: string;
  /** Перевизначити усталене. Без нього вирішує ширина екрана. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  // Читаємо збережений вибір після монтування (не під час рендера — SSR і
  // приватний режим не мають валити компонент). Будь-яка похибка сховища —
  // просто лишаємось на значенні за замовчуванням.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(`overlay:${storageKey}`);
    } catch {
      /* сховище недоступне — лишаємось на усталеному */
    }
    if (saved === "1" || saved === "0") {
      setOpen(saved === "1");
      return;
    }
    // Вибору ще не було — вирішує ширина. Саме тут, а не під час рендера:
    // на сервері вікна немає, і розмітка розійшлася б із клієнтською.
    if (defaultOpen !== undefined) return;
    setOpen(typeof window !== "undefined" && window.innerWidth >= WIDE_PX);
  }, [storageKey, defaultOpen]);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(`overlay:${storageKey}`, next ? "1" : "0");
      } catch {
        /* сховище недоступне — стан житиме лише в памʼяті */
      }
      return next;
    });
  };

  return (
    <div
      className={`pointer-events-auto max-h-full max-w-[240px] overflow-y-auto rounded border bg-background/92 backdrop-blur ${borderClass}`}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] ${textClass}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{title}</span>
        <ChevronDown
          className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? <div className="px-2.5 pb-2">{children}</div> : null}
    </div>
  );
}
