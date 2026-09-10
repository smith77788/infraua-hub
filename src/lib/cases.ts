import { slugify } from "../../platform/core/ingestion/slug";

/**
 * Справи: розслідування як обʼєкт, а не як вкладка браузера.
 *
 * До цього робота аналітика зникала при перезавантаженні: він знаходив вузол,
 * розбирав його критичність, моделював відмову — і не мав куди це покласти.
 * Знахідка, яку нікуди подіти, дорівнює її відсутності.
 *
 * Самі справи живуть у платформі: там рівні доступу, відсіки й журнал аудиту.
 * Тут — типи, перевірка вводу й підготовка до показу, тобто те, що можна
 * перевірити тестами без мережі.
 */

export interface CaseNote {
  text: string;
  at: string;
  author?: string;
}

export interface CaseFinding {
  summary: string;
  attachedAt: string;
  auditSeq?: number;
}

export interface AnalystCase {
  id: string;
  title: string;
  clearance: number;
  compartments?: string[];
  createdAt: string;
  notes?: CaseNote[];
  findings?: CaseFinding[];
  pinnedEntityIds?: string[];
}

/** Максимальна довжина назви — щоб перелік справ лишався читабельним. */
export const TITLE_MAX = 120;
export const NOTE_MAX = 2000;

export interface ValidationResult {
  ok: boolean;
  value: string;
  error?: string;
}

/**
 * Назва справи.
 *
 * Порожня назва відхиляється не з педантизму: справа без назви за тиждень
 * невідрізненна від будь-якої іншої, а перейменувати її платформа не дає.
 */
export function validateTitle(raw: string): ValidationResult {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { ok: false, value, error: "Назва не може бути порожньою." };
  if (value.length > TITLE_MAX) {
    return { ok: false, value, error: `Назва довша за ${TITLE_MAX} символів.` };
  }
  return { ok: true, value };
}

export function validateNote(raw: string): ValidationResult {
  const value = raw.trim();
  if (!value) return { ok: false, value, error: "Порожня нотатка нічого не додає." };
  if (value.length > NOTE_MAX) {
    return { ok: false, value, error: `Нотатка довша за ${NOTE_MAX} символів.` };
  }
  return { ok: true, value };
}

export interface CaseSummary {
  id: string;
  title: string;
  /** Скільки всього записів у справі — нотатки, знахідки, приколоті обʼєкти. */
  entries: number;
  notes: number;
  findings: number;
  pinned: number;
  createdAt: string;
}

/** Зведення для переліку. Порожня справа так і називається порожньою. */
export function summarizeCase(item: AnalystCase): CaseSummary {
  const notes = item.notes?.length ?? 0;
  const findings = item.findings?.length ?? 0;
  const pinned = item.pinnedEntityIds?.length ?? 0;
  return {
    id: item.id,
    title: item.title,
    entries: notes + findings + pinned,
    notes,
    findings,
    pinned,
    createdAt: item.createdAt,
  };
}

/**
 * Чи вже приколотий обʼєкт до справи.
 *
 * Потрібне, щоб не пропонувати «додати» те, що вже додане: повторний клік мав
 * би вигляд дії, яка нічого не робить.
 */
export function isPinned(item: AnalystCase, entityId: string): boolean {
  return (item.pinnedEntityIds ?? []).includes(entityId);
}

/**
 * Ідентифікатор обʼєкта консолі в термінах платформи.
 *
 * Консоль знає обʼєкт як `way/123`, платформа — як `infraua_facility_way123`
 * після `slugify`. Без цього перетворення «приколоти» вказувало б у порожнечу:
 * платформа мовчки відхилила б посилання на неіснуюче, і на екран не потрапило
 * б нічого.
 *
 * Правило береться з `platform/core/ingestion/slug.ts` — того самого файлу, з
 * якого його бере платформа. Це не імпорт заради ощадливості: копія цього
 * правила по обидва боки межі розійшлася б тихо, а помітили б це вже тоді,
 * коли справи почали б збиратися порожніми.
 */
export function platformEntityId(facilityId: string): string {
  return slugify(`infraua_facility_${facilityId}`);
}
