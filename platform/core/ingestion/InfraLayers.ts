/**
 * Чи приймає це розгортання обʼєкти критичної інфраструктури України.
 *
 * Дзеркало вимикача в консолі (`src/lib/infra-gate.ts`), і з тієї самої
 * причини. Консоль малює карту; платформа тримає граф, у якому та сама
 * картина живе довше, зводиться з іншими наборами і читається запитами. Якщо
 * вимкнути лише показ, дані все одно накопичуються там, звідки їх можна
 * дістати, — і вимикач стає косметичним.
 *
 * Усталене значення — «не приймати». Розгортання, яке мовчить, нічого не
 * пише: інша сторона цього усталеного значення означала б, що граф наповнюють
 * ті, хто про вимикач не знав.
 *
 * `INFRA_LAYERS=on` вмикає. Будь-яке інше значення — ні.
 */

export const INFRA_LAYERS_FLAG = 'INFRA_LAYERS';

export function infraLayersEnabled(): boolean {
  return process.env[INFRA_LAYERS_FLAG] === 'on';
}

export const INFRA_DISABLED_REASON =
  'This deployment does not ingest Ukrainian critical-infrastructure objects ' +
  `(set ${INFRA_LAYERS_FLAG}=on to enable).`;
