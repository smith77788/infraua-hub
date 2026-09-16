/**
 * Чи доїжджає написаний код до людей.
 *
 * ## Навіщо це існує
 *
 * 15.09 о 17:19 у `package.json` додали залежність, а лок не оновили.
 * `bun install --frozen-lockfile` на такій розбіжності падає, і bun вмикає цей
 * режим САМ, коли в оточенні `CI=true`. Тож упала і перевірка, і збірка — тієї
 * самої хвилини. Далі добу три сесії писали код, який фізично не міг доїхати, і
 * шукали вади в тому, що бачили на екрані, тобто у вчорашній збірці.
 *
 * Жодне з виправлень не було зайвим, але жодне й не допомогло: дефект був не в
 * коді, а в тому, що конвеєр став МОВЧКИ. Прилад, який цього не показує, і є
 * справжня вада — вона повторюється з будь-якою наступною причиною зупинки.
 *
 * ## Чому це питання до самої системи, а не до дошки CI
 *
 * Дошку треба ПІТИ й подивитись, і саме цього ніхто не робить, поки все
 * начебто працює. Натомість запущена збірка знає свій коміт і може спитати, що
 * зараз у гілці. Розбіжність між «що я» і «що має бути» — це вимір, і система
 * здатна зробити його сама, без людини.
 *
 * ## Три різні стани, які не можна плутати
 *
 * • **Перевірка червона** — нічого не поїде, і винен код. Треба лагодити.
 * • **Перевірка зелена, а збірка відстала** — код здоровий, став конвеєр.
 *   Лагодити треба розгортання, а не код, і це протилежні дії.
 * • **Невідомо** — не змогли спитати. Це теж стан, і мовчати про нього чесніше,
 *   ніж видати «усе гаразд»: саме таке «гаразд» і коштувало доби.
 */

/** Скільки чекати, перш ніж відставання вважати зупинкою, а не деплоєм у дорозі. */
export const DEPLOY_GRACE_MS = 30 * 60 * 1000;

export type CiConclusion = "success" | "failure" | "pending" | "unknown";

export interface PipelineFacts {
  /** Коміт, з якого зібрана ЦЯ збірка. `null` — оточення не сказало. */
  deployedSha: string | null;
  /** Коміт, який зараз у головній гілці. `null` — не змогли спитати. */
  headSha: string | null;
  /** Коли зʼявився цей коміт, мс. `null` — невідомо. */
  headAt: number | null;
  /** Чим скінчилась перевірка на цьому коміті. */
  ci: CiConclusion;
}

export type PipelineLevel = "ok" | "ci-broken" | "deploy-stuck" | "unknown";

export interface PipelineAssessment {
  level: PipelineLevel;
  /** Одним рядком: що саме сталося. */
  reason: string;
  /** Скільки збірка відстає за часом, мс. `null` — незастосовно. */
  behindMs: number | null;
}

/**
 * Оцінка стану конвеєра.
 *
 * Порядок перевірок не випадковий: спершу «чи є з чим порівнювати», далі «чи
 * здоровий код», і лише потім «чи їде». Червона перевірка пояснює відставання
 * повністю, і називати обидва стани одразу означало б давати дві різні
 * інструкції на одну причину.
 */
export function assessPipeline(facts: PipelineFacts, now: number): PipelineAssessment {
  if (!facts.deployedSha || !facts.headSha) {
    return {
      level: "unknown",
      reason: !facts.deployedSha
        ? "невідомо, з якого коміту зібрана ця збірка"
        : "не вдалося дізнатись, що зараз у гілці",
      behindMs: null,
    };
  }

  if (facts.ci === "failure") {
    return {
      level: "ci-broken",
      reason: "перевірка на верхівці гілки червона — звідси не поїде нічого",
      behindMs: facts.headAt === null ? null : Math.max(0, now - facts.headAt),
    };
  }

  if (facts.deployedSha === facts.headSha) {
    return { level: "ok", reason: "збірка відповідає верхівці гілки", behindMs: 0 };
  }

  /*
   * Відстала збірка — ще не поломка: деплой триває хвилини. Поломкою це стає
   * тоді, коли часу вже точно вистачило. Без відмітки часу коміту судити нема
   * на чому — тоді мовчимо, а не вгадуємо.
   */
  if (facts.headAt === null) {
    return {
      level: "unknown",
      reason: "збірка відстала, але невідомо, відколи — судити нема на чому",
      behindMs: null,
    };
  }

  const behindMs = Math.max(0, now - facts.headAt);
  if (behindMs < DEPLOY_GRACE_MS) {
    return { level: "ok", reason: "збірка відстала, але деплой ще в дорозі", behindMs };
  }

  return {
    level: "deploy-stuck",
    reason: "перевірка не червона, але збірка так і не оновилась — став конвеєр",
    behindMs,
  };
}

function hours(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} хв`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} год ${min % 60} хв` : `${Math.floor(h / 24)} д ${h % 24} год`;
}

const SHORT = (sha: string | null) => (sha ? sha.slice(0, 7) : "—");

/**
 * Рядок для `/stats`.
 *
 * Мовчить, коли все гаразд: рядок «конвеєр працює» серед інших рядків читається
 * як фон і перестає помічатись — рівно як і його зникнення.
 */
export function pipelineLine(a: PipelineAssessment, facts: PipelineFacts): string | null {
  if (a.level === "ok") return null;
  if (a.level === "unknown") return `⚙️ Конвеєр: ${a.reason}`;
  const behind = a.behindMs === null ? "" : ` (${hours(a.behindMs)})`;
  return [
    `🛑 <b>Код не доїжджає до людей</b>${behind}`,
    a.reason,
    `Зібрано з <code>${SHORT(facts.deployedSha)}</code>, у гілці <code>${SHORT(facts.headSha)}</code>`,
  ].join("\n");
}

/**
 * Повідомлення власнику — з конкретною наступною дією.
 *
 * Діагноз без дії — це те саме мовчання, лише багатослівне: власник бачить
 * «щось не так» і не знає, куди йти. Дії для двох станів РІЗНІ й протилежні:
 * червона перевірка — лагодити код, застряглий деплой — лагодити розгортання.
 */
export function renderPipelineAlert(a: PipelineAssessment, facts: PipelineFacts): string {
  const behind = a.behindMs === null ? "" : ` вже ${hours(a.behindMs)}`;
  const head = `Зібрано з <code>${SHORT(facts.deployedSha)}</code>, у гілці <code>${SHORT(facts.headSha)}</code>.`;
  if (a.level === "ci-broken") {
    return [
      `🛑 <b>Перевірка червона${behind}</b>`,
      "",
      "Звідси не поїде нічого: усе написане лишається в гілці, а люди далі бачать стару збірку.",
      head,
      "",
      "<i>Лагодити треба код. Найчастіша причина — лок не збігається з package.json: тоді встановлення падає ще до тестів.</i>",
    ].join("\n");
  }
  return [
    `🛑 <b>Збірка не оновлюється${behind}</b>`,
    "",
    "Перевірка не червона, тобто код здоровий, — але розгортання не забрало його.",
    head,
    "",
    "<i>Лагодити треба розгортання, не код: чи не вимкнено автодеплой, чи з тієї гілки він збирає, чи не падає сама збірка.</i>",
  ].join("\n");
}

/** Повідомлення про одужання: без нього не видно, що зупинка скінчилась. */
export function renderPipelineRecovered(facts: PipelineFacts): string {
  return [
    "✅ <b>Конвеєр поїхав</b>",
    "",
    `Збірка відповідає верхівці гілки: <code>${SHORT(facts.headSha)}</code>.`,
  ].join("\n");
}

/**
 * Чи казати про це власнику зараз.
 *
 * Стан порівнюється зі станом, а не з часом: поки нічого не змінилось, повторне
 * повідомлення нічого не додає, а привчає його гортати. Але ПЕРЕХІД — і в
 * поломку, і з поломки — сказати треба обовʼязково, інакше власник не дізнається
 * ні що зламалось, ні що полагодилось.
 *
 * `unknown` навмисно не будить нікого: «не змогли спитати» — це майже завжди
 * мережа, і будити на кожен збій мережі означає знецінити всі повідомлення.
 */
export function pipelineNotice(
  level: PipelineLevel,
  lastNotified: PipelineLevel | null,
): "alert" | "recovered" | null {
  if (level === "unknown") return null;
  if (level === lastNotified) return null;
  if (level === "ok") {
    // Одужання варте слова лише після справжньої поломки.
    return lastNotified === "ci-broken" || lastNotified === "deploy-stuck" ? "recovered" : null;
  }
  return "alert";
}
