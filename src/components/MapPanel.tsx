import { ChevronDown, X, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Панель над картою, яку можна згорнути — і яка памʼятає це рішення.
 *
 * ## Навіщо
 *
 * Карта — головне, що є в консолі, і кожна нова панель відбирає в неї місце.
 * Панелі корисні, але не всі й не всім: одному потрібен прогноз руху рою,
 * іншому — перелік хвиль, третьому нічого, крім самої карти. Доки згорнути було
 * нічим, «корисно» й «заважає» розрізняв лише той, хто панель додав.
 *
 * Гірше: три панелі вміли згортатись, а дві найбільші — ні, і кожна робила це
 * власним кодом. Тобто поведінка залежала від того, хто писав панель, а не від
 * того, чого хоче людина.
 *
 * ## Що памʼятається
 *
 * Стан кожної панелі окремо, у сховищі браузера. Вибір «згорнути» — це не
 * разова дія, а налаштування: людина, яка щоразу згортає те саме, каже нам, що
 * воно їй не потрібне, і питати вдруге неввічливо.
 *
 * ## Чому на вузькому екрані згорнуто за замовчуванням
 *
 * На телефоні дві розгорнуті панелі не лишають від карти нічого. Там ціна місця
 * найвища, тож усталене — згорнуто; хто хоче, розгорне одним дотиком, і це
 * запамʼятається. На широкому екрані місця вистачає, і панель відкрита одразу.
 */

const TONE = {
  cyan: {
    border: "border-cyan-500/40",
    text: "text-cyan-300",
    chip: "border-cyan-500/40 text-cyan-300 hover:border-cyan-400",
  },
  orange: {
    border: "border-orange-500/40",
    text: "text-orange-300",
    chip: "border-orange-500/40 text-orange-300 hover:border-orange-400",
  },
  neutral: {
    border: "border-border",
    text: "text-muted-foreground",
    chip: "border-border text-muted-foreground hover:text-foreground",
  },
} as const;

export type PanelTone = keyof typeof TONE;

/** Ширина, з якої панелі відкриті одразу. Нижче — карта дорожча. */
const WIDE_PX = 640;

function storageKey(id: string): string {
  return `map-panel:${id}`;
}

/**
 * Читання з памʼяті браузера буває недоступним — приватне вікно, заборонені
 * дані сайту. Тоді просто беремо усталене: панель має працювати й без памʼяті.
 */
function readOpen(id: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(storageKey(id));
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

export interface MapPanelProps {
  /** Стабільний ключ памʼяті. Міняти не можна — з ним губиться вибір людини. */
  id: string;
  title: string;
  /**
   * Коротка назва для згорнутого чипа.
   *
   * Потрібна саме тому, що чипи стоять у вузьких колонках: «Прогноз руху рою»
   * там обрізається до «Прогноз ру…», і з обрізка не видно, що всередині. Краще
   * коротке слово цілком, ніж довге наполовину.
   */
  short?: string;
  icon: LucideIcon;
  tone?: PanelTone;
  /** Короткий підсумок на згорнутій панелі: щоб згортання не ховало головного. */
  badge?: string;
  className?: string;
  children: ReactNode;
}

export default function MapPanel({
  id,
  title,
  short,
  icon: Icon,
  tone = "neutral",
  badge,
  className = "",
  children,
}: MapPanelProps) {
  /*
   * Перший показ — усталене за шириною, і лише ПІСЛЯ монтування підхоплюємо
   * збережений вибір. Читати сховище під час рендеру не можна: на сервері його
   * немає, і розмітка розійшлася б із клієнтською.
   */
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const wide = typeof window !== "undefined" && window.innerWidth >= WIDE_PX;
    setOpen(readOpen(id, wide));
  }, [id]);

  const remember = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(storageKey(id), next ? "1" : "0");
    } catch {
      // Памʼяті немає — рішення діє до перезавантаження. Це краще, ніж нічого.
    }
  };

  const t = TONE[tone];

  if (!open) {
    return (
      <button
        onClick={() => remember(true)}
        title={title}
        aria-label={`Розгорнути: ${title}`}
        className={`pointer-events-auto flex max-w-full items-center gap-1.5 rounded-full border bg-background/90 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] backdrop-blur transition-colors ${t.chip}`}
      >
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{short ?? title}</span>
        {badge ? <span className="shrink-0 font-semibold">{badge}</span> : null}
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </button>
    );
  }

  return (
    <div
      className={`pointer-events-auto max-h-full overflow-y-auto rounded border bg-background/92 px-2.5 py-2 backdrop-blur ${t.border} ${className}`}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span
          className={`flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] ${t.text}`}
        >
          <Icon className="size-3 shrink-0" />
          <span className="truncate">{title}</span>
          {badge ? <span className="shrink-0 font-semibold">{badge}</span> : null}
        </span>
        <button
          onClick={() => remember(false)}
          aria-label={`Згорнути: ${title}`}
          title="Згорнути"
          className="-mr-0.5 -mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}
