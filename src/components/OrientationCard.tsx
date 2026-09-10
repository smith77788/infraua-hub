import { Layers, Radio, Share2, Table2, X } from "lucide-react";
import type { ReactNode } from "react";

/*
 * Орієнтир для першого відкриття консолі. Консоль щільна: карта, оверлеї,
 * фільтри, панелі — новій людині незрозуміло, на що дивитись і що означають
 * позначки. Ця картка коротко пояснює головне й прибирається одним рухом
 * (стан памʼятається в localStorage). Її можна відкрити знову кнопкою «?»
 * у шапці — тому компонент керований ззовні.
 */

const LS_KEY = "infraua.oriented.v1";

/** Чи бачив користувач орієнтир (безпечно до SSR і приватного режиму). */
export function hasSeenOrientation(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "1";
  } catch {
    return true; // немає доступу до сховища — не набридаємо карткою
  }
}

function remember() {
  try {
    localStorage.setItem(LS_KEY, "1");
  } catch {
    /* приватний режим — просто не памʼятаємо */
  }
}

function Row({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded border border-border bg-card text-primary">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-foreground">{title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

export default function OrientationCard({ onClose }: { onClose: () => void }) {
  const close = () => {
    remember();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Як читати консоль"
      onClick={close}
    >
      <div
        className="max-h-full w-full max-w-md overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[13px] uppercase tracking-[0.14em] text-foreground">
              Оперативна консоль InfraUA
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Жива карта критичної інфраструктури України й повітряної обстановки. Усі дані — з
              відкритих джерел, без ключів, оновлюються автоматично.
            </p>
          </div>
          <button
            onClick={close}
            aria-label="Закрити"
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3 border-t border-border pt-3">
          <Row icon={<Layers className="size-3.5" />} title="Позначки на карті">
            Кольорові точки — обʼєкти за типом: енергетика, підстанції, вода, лікарні, нафта/газ,
            звʼязок. Лінії — електромережа. Легенда кольорів — кнопкою внизу карти.
          </Row>
          <Row icon={<Radio className="size-3.5" />} title="Повітряні цілі">
            Пульсуючі позначки — цілі за типом: дрон (Shahed), крилата чи балістична ракета, КАБ,
            авіація. Стрілка показує курс. Тип визначається з OSINT-повідомлень.
          </Row>
          <Row icon={<Share2 className="size-3.5" />} title="Звʼязки й загрози">
            Праворуч — обʼєкти під загрозою (ціль поруч). «Граф звʼязків» показує ланцюг обʼєкт ←
            ціль ← канал-джерело.
          </Row>
          <Row icon={<Table2 className="size-3.5" />} title="Керування">
            Ліворуч — пошук і фільтри за типом. Згори — таблиця, граф, брифінг. На карті «Шари»
            вмикають лінію фронту, пожежі та інші оверлеї.
          </Row>
        </div>

        <button
          onClick={close}
          className="mt-4 w-full rounded border border-primary/50 bg-primary/10 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-primary transition-colors hover:bg-primary/20"
        >
          Зрозуміло
        </button>
      </div>
    </div>
  );
}
