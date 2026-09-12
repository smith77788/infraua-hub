"""Доповідь як структура: одне повідомлення — кілька цілей і короткі маршрути.

Джерело (`detoyshahed`) віддає інциденти плоским списком, але кожен несе
`report_id` — ідентифікатор ОДНОГО вихідного повідомлення OSINT-каналу. Досі
це поле не використовувалося зовсім: кожна згадка ставала окремою «ціллю» без
курсу, а звʼязок «це сказано в одній доповіді» губився.

Що з цим не так було зробити навпаки. Спокуслива гіпотеза — «перелік точок у
доповіді це маршрут цілі» — ПЕРЕВІРЕНА НА ЖИВИХ ДАНИХ І НЕ ПІДТВЕРДИЛАСЬ:
у 140 інцидентах (12.09.2026) 36 переходів між сусідніми точками доповідей,
медіана 161 км, 53% переходів довші за 150 км. Тобто типова доповідь — це
«Полтава, Народичі, Сорокошичі», три різні цілі в одному повідомленні, а не
шлях однієї.

Але розподіл виявився двомодальним: 13, 14, 19, 19, 30, 33 км — і далі розрив
до 61, 62, 73, 108, 126, 161 і більше. Короткі переходи — це справді одна ціль
у русі («з Рівного курсом на Гощу», 30 км), довгі — різні цілі.

Тому алгоритм такий: доповідь РІЖЕТЬСЯ на ланцюги за порогом переходу. Ланцюг
із ≥2 точок дає курс і маршрут (позиція = остання точка). Поодинокі точки
лишаються окремими спостереженнями, але памʼятають, що прийшли однією
доповіддю — це контекст хвилі, який видно в досьє цілі.

Поріг 50 км узятий НИЖЧЕ спостереженого розриву (33 → 61) свідомо: помилка в
цей бік дробить одну ціль на дві, а не вигадує курс, якого не було.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .geocode import azimuth_deg, haversine_km

# Максимальний перехід всередині одного ланцюга (км). Обґрунтування — у docstring.
MAX_HOP_KM = 50.0


@dataclass
class ReportPoint:
    name: str
    lat: float
    lon: float
    incident_id: str = ""
    display_name: str = ""
    count: int = 1


@dataclass
class Chain:
    """Ланцюг точок однієї доповіді — гіпотеза про одну ціль."""

    points: list[ReportPoint]
    report_id: str = ""
    siblings: int = 0  # скільки ще цілей було в тій самій доповіді

    @property
    def head(self) -> ReportPoint:
        """Остання згадана точка — поточна відома позиція."""
        return self.points[-1]

    @property
    def heading(self) -> float | None:
        """Курс за ланцюгом. None для поодинокої точки — курсу ми не знаємо."""
        if len(self.points) < 2:
            return None
        a, b = self.points[0], self.points[-1]
        if haversine_km((a.lat, a.lon), (b.lat, b.lon)) < 1:
            return None
        return round(azimuth_deg((a.lat, a.lon), (b.lat, b.lon)), 1)

    @property
    def waypoints(self) -> list[list[float]]:
        return [[p.lat, p.lon] for p in self.points]

    @property
    def route_label(self) -> str | None:
        if len(self.points) < 2:
            return None
        return " → ".join(p.name for p in self.points)

    @property
    def count(self) -> int:
        return max((p.count for p in self.points), default=1)

    def stable_id(self, index: int) -> str:
        """Стабільний id: ланцюг однієї доповіді не змінює номер між опитуваннями."""
        if len(self.points) == 1 and self.points[0].incident_id:
            return self.points[0].incident_id
        return f"{self.report_id}:{index}"


def segment(points: list[ReportPoint], max_hop_km: float = MAX_HOP_KM) -> list[list[ReportPoint]]:
    """Ріже послідовність точок доповіді на географічно когерентні ланцюги."""
    if not points:
        return []
    chains: list[list[ReportPoint]] = [[points[0]]]
    for p in points[1:]:
        prev = chains[-1][-1]
        if haversine_km((prev.lat, prev.lon), (p.lat, p.lon)) <= max_hop_km:
            chains[-1].append(p)
        else:
            chains.append([p])
    return chains


def chains_of_report(
    report_id: str, points: list[ReportPoint], max_hop_km: float = MAX_HOP_KM
) -> list[Chain]:
    """Ланцюги однієї доповіді; кожен знає, скільки ще цілей поруч у ній."""
    segs = segment(points, max_hop_km)
    out = [Chain(points=s, report_id=report_id) for s in segs]
    for c in out:
        c.siblings = len(out) - 1
    return out
