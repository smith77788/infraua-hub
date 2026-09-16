import { useEffect, useState } from "react";

import { shellIsStale } from "@/lib/build-info";

/**
 * «Ви дивитесь на стару збірку».
 *
 * ## Навіщо
 *
 * WebView Telegram тримає HTML-оболонку, а та просить хешовані ассети, які
 * віддаються `immutable`. Тож людина може нескінченно бачити збірку тижневої
 * давнини, хоч на сервері лежить свіжа, і жоден редеплой цього не лікує.
 * Найгірше — це НЕ ВИДНО: інтерфейс виглядає справним, просто виправлень у
 * ньому немає. Двічі поспіль на це витрачали час, шукаючи ваду, якої в коді
 * вже не було.
 *
 * ## Як перевіряється
 *
 * Оболонка несе мітку збірки, з якою її віддав сервер (`<meta name="x-build">`).
 * Запит `/api/build` завжди йде на сервер і повертає поточну. Різниця між ними
 * означає рівно одне: оболонка прийшла зі сховища, а не з сервера.
 *
 * Якщо якоїсь мітки бракує — мовчимо. Сказати «все свіже», не маючи з чим
 * звірити, було б тим самим тихим неправдивим твердженням, проти якого ця
 * перевірка й потрібна.
 */
export default function StaleShellNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const shell =
      document.querySelector<HTMLMetaElement>('meta[name="x-build"]')?.content?.trim() || null;
    if (!shell) return;
    let alive = true;
    /*
     * `cache: "no-store"` тут не перестраховка: без нього відповідь могла б
     * прийти з того самого сховища, що й оболонка, і перевірка звіряла б стару
     * мітку зі старою — тобто завжди мовчала б.
     */
    void fetch("/api/build", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { sha?: string } | null) => {
        if (!alive) return;
        if (shellIsStale(shell, data?.sha ?? null) === true) setStale(true);
      })
      .catch(() => {
        // Мережа мовчить — це не привід стверджувати щось про збірку.
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!stale) return null;

  return (
    <div className="border-b border-amber-500/50 bg-amber-500/10 px-3 py-2 text-center font-mono text-[10px] leading-snug text-amber-300">
      Ви бачите стару версію консолі — її тримає кеш браузера.{" "}
      <button
        onClick={() => {
          // `reload()` без аргументів: примусове перезавантаження з ігноруванням
          // кешу нестандартне й у частині WebView просто не працює. Оболонка
          // віддається з `no-cache`, тож звичайного перезавантаження досить.
          window.location.reload();
        }}
        className="underline underline-offset-2 hover:text-amber-200"
      >
        Оновити
      </button>
    </div>
  );
}
