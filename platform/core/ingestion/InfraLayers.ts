import * as fs from 'fs';
import * as path from 'path';
import { AuditLog } from '../audit/AuditLog';

/**
 * Чи приймає це розгортання обʼєкти критичної інфраструктури України.
 *
 * Вимикач складається з двох частин, і це навмисно.
 *
 * **Дозвіл** — змінна оточення `INFRA_LAYERS=on`. Живе в дашборді, змінюється
 * тим, хто має доступ до розгортання. Без неї шарів немає ніколи, і жодна
 * команда ззовні цього не змінить.
 *
 * **Стан** — перемикач, збережений на диску поруч із рештою стану платформи.
 * Його крутить оператор (з бота, з API), і саме він відповідає на питання «чи
 * показуємо зараз».
 *
 * Шари увімкнені, лише коли **обидві** частини кажуть «так». Композиція саме
 * така, а не «або», бо ролі різні: дозвіл — це рішення власника розгортання,
 * стан — щоденна ручка. Ручка, здатна ввімкнути те, чого власник не дозволяв,
 * — це не ручка, а обхід.
 *
 * Зворотний бік важливіший: вимкнути можна **завжди**, обома частинами
 * незалежно. Вимикач, який може заклинити в положенні «увімкнено», гірший за
 * його відсутність.
 *
 * Усталене значення обох частин — «вимкнено». Розгортання, яке мовчить,
 * нічого не віддає: інша сторона цього усталеного означала б, що шари
 * публікує той, хто про них не знав.
 */

export const INFRA_LAYERS_FLAG = 'INFRA_LAYERS';

/** Дозвіл розгортання. Читається на кожен виклик — див. коментар нижче. */
export function infraLayersPermitted(): boolean {
  // Не один раз при старті: збірка йде під контейнер, який рестартує при зміні
  // змінної, але тести міняють її на льоту, і значення, обчислене при
  // завантаженні модуля, зробило б їх залежними від порядку імпорту.
  return process.env[INFRA_LAYERS_FLAG] === 'on';
}

export interface InfraLayersState {
  /** Ручка оператора. */
  enabled: boolean;
  /** Хто крутив останнім і коли — щоб «чому вимкнено» мало відповідь. */
  changedBy: string | null;
  changedAt: string | null;
  reason: string | null;
}

const DEFAULT_STATE: InfraLayersState = {
  enabled: false,
  changedBy: null,
  changedAt: null,
  reason: null,
};

/**
 * Перемикач, що переживає рестарт.
 *
 * Окремий маленький файл, а не рядок у конфігу: конфіг лежить у git і
 * оновлюється деплоєм, а це — оперативний стан, який крутять з телефона о
 * третій ночі. Змішати їх означало б, що наступний деплой мовчки вертає
 * перемикач у те положення, у якому його закомітили.
 */
export class InfraLayersStore {
  private readonly file: string;
  private cached: InfraLayersState | null = null;

  constructor(
    dataRoot: string,
    private readonly audit: AuditLog,
  ) {
    this.file = path.join(dataRoot, 'infra-layers.json');
  }

  /** Положення ручки. Пошкоджений файл читається як «вимкнено». */
  state(): InfraLayersState {
    if (this.cached) return this.cached;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<InfraLayersState>;
      this.cached = {
        enabled: raw.enabled === true,
        changedBy: typeof raw.changedBy === 'string' ? raw.changedBy : null,
        changedAt: typeof raw.changedAt === 'string' ? raw.changedAt : null,
        reason: typeof raw.reason === 'string' ? raw.reason : null,
      };
    } catch {
      // Немає файлу або він зіпсований — усталене «вимкнено». Помилятися тут
      // треба в той бік, де нічого не публікується.
      this.cached = { ...DEFAULT_STATE };
    }
    return this.cached;
  }

  /** Чи віддавати обʼєкти інфраструктури: дозвіл І ручка. */
  enabled(): boolean {
    return infraLayersPermitted() && this.state().enabled;
  }

  /** Чому саме такий стан — щоб оператор не гадав, яка з двох частин закрита. */
  explain(): { enabled: boolean; permitted: boolean; switchedOn: boolean; state: InfraLayersState } {
    const state = this.state();
    const permitted = infraLayersPermitted();
    return { enabled: permitted && state.enabled, permitted, switchedOn: state.enabled, state };
  }

  set(enabled: boolean, actor: string, reason?: string): InfraLayersState {
    const next: InfraLayersState = {
      enabled,
      changedBy: actor,
      changedAt: new Date().toISOString(),
      reason: reason?.trim() ? reason.trim() : null,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    this.cached = next;

    // У ланцюг аудиту — як і кожна інша зміна, що міняє видиме назовні.
    this.audit.append(actor, enabled ? 'infra_layers_on' : 'infra_layers_off', {
      enabled,
      permitted: infraLayersPermitted(),
      reason: next.reason,
    });
    return next;
  }

  /** Тільки для тестів: скинути памʼять між прогонами. */
  forget(): void {
    this.cached = null;
  }
}

export const INFRA_DISABLED_REASON =
  'This deployment does not ingest Ukrainian critical-infrastructure objects.';
