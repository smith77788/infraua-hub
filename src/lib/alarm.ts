/**
 * Тривога для точки користувача: звук, вібрація, сповіщення.
 *
 * Це найважливіша функція саме на телефоні й уночі: людина спить, і єдине, що
 * має її розбудити, — коли до її точки йде НОВА ціль. Не «є цілі в країні»
 * (їх завжди багато), а саме поява нової вхідної на її напрямок.
 *
 * Тому логіка «коли бити на сполох» винесена в чисту функцію й покрита
 * тестами: `newInboundIds` порівнює попередній і поточний набір вхідних цілей
 * і повертає лише ті, що зʼявилися. Сам сигнал (WebAudio, Vibration API,
 * Notifications) — окремо, бо він невіддільний від DOM.
 */

/**
 * Ідентифікатори цілей, що стали вхідними ЩОЙНО (є зараз, не було раніше).
 * Порожній масив — нічого нового, тривожити не треба.
 */
export function newInboundIds(prev: readonly string[], curr: readonly string[]): string[] {
  const before = new Set(prev);
  return curr.filter((id) => !before.has(id));
}

/**
 * Короткий двотональний сигнал через WebAudio — без зовнішніх файлів, щоб
 * працювало офлайн і в Telegram Mini App. Потребує, щоб контекст був
 * створений/відновлений у відповідь на дію користувача (увімкнення звуку).
 */
export function playBeep(ctx: AudioContext): void {
  const now = ctx.currentTime;
  [
    [0, 880],
    [0.26, 660],
  ].forEach(([offset, freq]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq!;
    gain.gain.setValueAtTime(0.0001, now + offset!);
    gain.gain.exponentialRampToValueAtTime(0.14, now + offset! + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset! + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + offset!);
    osc.stop(now + offset! + 0.24);
  });
}

/** Вібрація телефону (Android/Telegram). На iOS ігнорується — не помилка. */
export function vibrate(pattern: number[] = [200, 100, 200]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* пристрій без вібрації */
  }
}

/** Десктопне/системне сповіщення, якщо дозвіл надано. */
export function notify(title: string, body: string, tag?: string): void {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, tag ? { body, tag } : { body });
    }
  } catch {
    /* сповіщення недоступні */
  }
}
