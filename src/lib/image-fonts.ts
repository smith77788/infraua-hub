/**
 * Шрифт для картинок каналу — свій, а не «який знайдеться в контейнері».
 *
 * ## Вада, яку це закриває
 *
 * Знімок із проду: зум «Запоріжжя» — кружечки й межі, і ЖОДНОГО тексту: ні
 * назви міста, ні «10 / 25 / 50 км», ні сусідніх міст, ні «Пн», ні пояснення.
 * Користувач: «досі не розуміє, що на зображенні». Відтворено точно:
 * растеризатор (resvg) без доступних шрифтів мовчки пропускає кожен <text>.
 * Локально системні шрифти є — тому ні розробка, ні тести цього не бачили; у
 * контейнері Railway їх немає.
 *
 * Тепер шрифт лежить у репозиторії (`assets/fonts`, DejaVu Sans — вільна
 * ліцензія, повна кирилиця, див. LICENSE-DejaVu.txt) і передається явно.
 * Системні лишаються запасом, а не єдиною надією.
 *
 * `fontStatus()` іде в /api/health: якщо файлу не знайдено, це видно одним
 * запитом, а не з чергового «незрозумілого» знімка.
 */

const FILES = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"];
export const IMAGE_FONT_FAMILY = "DejaVu Sans";

let cached: { files: string[]; dir: string | null } | null = null;

async function locate(): Promise<{ files: string[]; dir: string | null }> {
  if (cached) return cached;
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  // Railway запускає процес із кореня репозиторію (`npm start`), тож перший
  // кандидат — звідти; змінна — для інших розкладок.
  const dirs = [
    process.env["IMAGE_FONTS_DIR"],
    join(process.cwd(), "assets", "fonts"),
    join(process.cwd(), "..", "assets", "fonts"),
  ].filter((d): d is string => typeof d === "string" && d.length > 0);
  for (const dir of dirs) {
    const files = FILES.map((f) => join(dir, f)).filter((p) => existsSync(p));
    if (files.length) return (cached = { files, dir });
  }
  return (cached = { files: [], dir: null });
}

/** Опції шрифтів для resvg: наш файл + системні як запас. */
export async function resvgFontOptions(): Promise<{
  fontFiles: string[];
  loadSystemFonts: boolean;
  defaultFontFamily: string;
  sansSerifFamily: string;
}> {
  const { files } = await locate();
  return {
    fontFiles: files,
    loadSystemFonts: true,
    defaultFontFamily: IMAGE_FONT_FAMILY,
    sansSerifFamily: IMAGE_FONT_FAMILY,
  };
}

/** Для /api/health: чи знайдено наш шрифт. Без нього текст на картинках може зникнути. */
export async function fontStatus(): Promise<{ bundled: boolean; files: number }> {
  const { files } = await locate();
  return { bundled: files.length > 0, files: files.length };
}
