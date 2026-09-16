/**
 * Яка збірка зараз перед людиною.
 *
 * ## Навіщо
 *
 * Двічі поспіль виправлення розкладки «не спрацьовувало»: на скріншотах був
 * напис, прибраний з коду добою раніше. Тобто дивились на стару збірку — і це
 * неможливо було ні підтвердити, ні спростувати, бо застосунок ніде не каже,
 * звідки він зібраний. Час ішов на пошук неіснуючої вади.
 *
 * Причина застрягання відома й описана окремо: WebView Telegram тримає
 * HTML-оболонку, та просить хешовані ассети, а вони віддаються `immutable` —
 * тож людина може нескінченно бачити стару збірку, хоч на сервері лежить нова,
 * і жоден редеплой цього не лікує.
 *
 * ## Як тут перевіряється
 *
 * Оболонка несе мітку збірки, з якою її віддав сервер. Сервер окремо каже свою
 * поточну мітку живим запитом. Якщо вони різні — перед людиною оболонка зі
 * сховища, а не з сервера, і це можна сказати прямо, замість гадати.
 *
 * Порівняння саме такої пари не випадкове: різниця між «що прийшло» і «що є
 * зараз» — єдине, що доводить застрягання. Одна мітка сама по собі не доводить
 * нічого: вона однаково виглядає і у свіжої збірки, і у місячної.
 */

/** Звідки взяли мітку — щоб похідне значення несло своє походження. */
export type BuildSource = "railway" | "git" | "env" | "unknown";

export interface BuildStamp {
  /** Повний хеш коміту, якщо відомий. */
  sha: string | null;
  /** Скорочення для показу людині. */
  short: string;
  source: BuildSource;
}

/** Сім символів — стільки ж показує git, і цього вистачає, щоб звірити очима. */
export function shortSha(sha: string | null | undefined): string {
  const s = (sha ?? "").trim();
  return s ? s.slice(0, 7) : "—";
}

/**
 * Мітка збірки з оточення.
 *
 * Railway підставляє `RAILWAY_GIT_COMMIT_SHA` сам; решта — запасні шляхи для
 * інших середовищ. Порядок від найнадійнішого до найзагальнішого, і джерело
 * повертається разом зі значенням: «невідомо звідки» — теж відповідь, і краща
 * за мовчазну вигадку.
 */
export function buildStamp(env: Record<string, string | undefined>): BuildStamp {
  const pairs: [BuildSource, string | undefined][] = [
    ["railway", env["RAILWAY_GIT_COMMIT_SHA"]],
    ["git", env["GIT_COMMIT_SHA"] ?? env["SOURCE_VERSION"] ?? env["VERCEL_GIT_COMMIT_SHA"]],
    ["env", env["BUILD_SHA"]],
  ];
  for (const [source, value] of pairs) {
    const sha = value?.trim();
    if (sha) return { sha, short: shortSha(sha), source };
  }
  return { sha: null, short: "—", source: "unknown" };
}

/**
 * Чи застрягла оболонка.
 *
 * `null` — відповіді немає: якщо хоч однієї мітки бракує, порівнювати нічого.
 * Повертати в цьому разі `false` було б гірше за мовчання: це твердження
 * «все свіже», зроблене без жодних підстав.
 */
export function shellIsStale(shellSha: string | null, serverSha: string | null): boolean | null {
  if (!shellSha || !serverSha) return null;
  return shellSha !== serverSha;
}

/** Назва мітки для людини: короткий хеш і звідки він. */
const SOURCE_WORD: Record<BuildSource, string> = {
  railway: "Railway",
  git: "git",
  env: "змінна оточення",
  unknown: "невідомо",
};

export function renderBuild(stamp: BuildStamp, startedAt: number, now: number): string {
  const upMin = Math.max(0, Math.round((now - startedAt) / 60_000));
  const up = upMin < 60 ? `${upMin} хв` : `${Math.floor(upMin / 60)} год ${upMin % 60} хв`;
  return [
    "🏷 <b>Збірка</b>",
    "",
    `Коміт: <code>${stamp.short}</code> (${SOURCE_WORD[stamp.source]})`,
    `Процес живе: ${up}`,
    "",
    stamp.sha
      ? "<i>Якщо в консолі інший номер — там стара оболонка зі сховища браузера, і її треба перезавантажити.</i>"
      : "<i>Середовище не підставило хеш коміту — звірити версії нема з чим. На Railway це <code>RAILWAY_GIT_COMMIT_SHA</code>.</i>",
  ].join("\n");
}
