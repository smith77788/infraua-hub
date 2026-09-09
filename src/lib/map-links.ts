import type { GraphEdge } from "./infra-types";
import { isObserved } from "./provenance";

/**
 * Які звʼязки малювати на карті, коли їх більше, ніж карта витримує.
 *
 * Стеля потрібна: кілька тисяч ліній у Leaflet — це помітно повільна карта.
 * Але спосіб її застосування — не дрібниця. Раніше бралися просто перші N,
 * тобто відкидання було випадковим щодо змісту: реальна лінія 330 кВ могла
 * зникнути, а здогадка «найближча підстанція» лишитися, бо просто стояла
 * раніше в масиві.
 *
 * Тут спостережені звʼязки мають перевагу. Якщо доводиться щось приховати,
 * ховається припущення, а не факт — і кількість прихованого повертається, щоб
 * її можна було назвати, а не мовчки втратити.
 */

export interface LinkSelection {
  visible: GraphEdge[];
  /** Скільки звʼязків не помістилося у стелю. */
  hidden: number;
  /** Скільки з показаних — спостережені. */
  observedVisible: number;
}

export function selectVisibleLinks(edges: GraphEdge[], limit: number): LinkSelection {
  if (edges.length <= limit) {
    let observed = 0;
    for (const e of edges) if (isObserved(e.provenance)) observed++;
    return { visible: edges, hidden: 0, observedVisible: observed };
  }

  const visible: GraphEdge[] = [];
  let observedVisible = 0;
  for (const e of edges) {
    if (!isObserved(e.provenance)) continue;
    if (visible.length >= limit) break;
    visible.push(e);
    observedVisible++;
  }
  for (const e of edges) {
    if (visible.length >= limit) break;
    if (isObserved(e.provenance)) continue;
    visible.push(e);
  }

  return { visible, hidden: edges.length - visible.length, observedVisible };
}

/** Стиль лінії за походженням: факт видно, здогадку — ледь. */
export function linkStyle(
  edge: GraphEdge,
  opts: { impacted: boolean },
): { color: string; weight: number; opacity: number; dashArray?: string } {
  if (opts.impacted) {
    return { color: "#ff9900", weight: 2, opacity: 0.85 };
  }
  if (isObserved(edge.provenance)) {
    // Реальна ЛЕП — суцільна і помітна.
    return { color: "#22d3ee", weight: 1.6, opacity: 0.55 };
  }
  // Виведене ребро — пунктир і ледь помітне: це припущення, і виглядати воно
  // має як припущення, а не як лінія на місцевості.
  return { color: "#64748b", weight: 0.8, opacity: 0.28, dashArray: "3 6" };
}
