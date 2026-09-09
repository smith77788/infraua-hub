"""Track Fusion & Motion Model — платформний примітив (розроблено в проєкті).

Проблема: сирі OSINT-повідомлення про одну й ту саму повітряну ціль надходять
повторно з різних каналів під різними id і як статичні точки. Наслідок —
дублікати треків і відсутність руху.

Рішення (внутрішній алгоритм):
1. Association — спостереження звʼязується з існуючим треком, якщо тип сумісний
   і воно потрапляє у просторово-часовий «гейт», що росте з часовою прогалиною
   × правдоподібну швидкість.
2. Update — оновлення історії, згладжених курсу/швидкості, часу останнього фіксу.
3. Motion (dead reckoning) — фоновий крок екстраполює позицію треку вздовж курсу
   зі швидкістю з моменту останнього фіксу (плавний рух між повідомленнями).
4. Confidence decay + expiry за часом без реальних спостережень.

Перевірено юніт-тестами (детермінований рух і асоціація).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .geocode import azimuth_deg, haversine_km, move_point
from .models import TYPE_META, TacticalObject

# Базовий радіус асоціації (км) та коефіцієнт росту з прогнозованим зміщенням.
BASE_GATE_KM = 18.0
GATE_SPEED_FACTOR = 1.6
# TTL за типом (сек): дрони живуть довше в ефірі, балістика — коротко.
TTL_BY_TYPE = {
    "shahed": 40 * 60,
    "recon": 40 * 60,
    "unknown": 25 * 60,
    "cruise": 12 * 60,
    "missile": 12 * 60,
    "ballistic": 6 * 60,
    "kab": 8 * 60,
    "aircraft": 20 * 60,
}
MAX_EXTRAP_MIN = 20  # не екстраполюємо далі, ніж на стільки хв без фіксу


def _compatible(a: str, b: str) -> bool:
    return a == b or a == "unknown" or b == "unknown"


def _merge_type(cur: str, new: str) -> str:
    # конкретний тип перемагає невідомий
    if cur == "unknown":
        return new
    return cur


@dataclass
class Track:
    id: str
    type: str
    lat: float
    lon: float
    source: str
    channel: str = ""
    raw: str = ""
    destination: str | None = None
    heading: float | None = None
    speed_kmh: float | None = None
    confidence: float = 0.5
    count: int = 1
    first_ts: float = field(default_factory=time.time)
    last_obs_ts: float = field(default_factory=time.time)
    obs_count: int = 1
    sources: set[str] = field(default_factory=set)
    history: list[tuple[float, float, float]] = field(default_factory=list)
    # поточна екстрапольована позиція (оновлюється motion-кроком)
    ex_lat: float = 0.0
    ex_lon: float = 0.0
    # крос-перевірка з офіційними зонами тривог (незалежний авторитетний сигнал)
    in_zone: bool = False
    zone_region: str | None = None

    def _speed(self) -> float:
        if self.speed_kmh:
            return self.speed_kmh
        return TYPE_META.get(self.type, TYPE_META["unknown"])["speed_kmh"]

    def to_dict(self) -> dict:
        meta = TYPE_META.get(self.type, TYPE_META["unknown"])
        wp = [[la, lo] for la, lo, _ in self.history[-6:]]
        if [self.ex_lat, self.ex_lon] != (wp[-1] if wp else None):
            wp = wp + [[self.ex_lat, self.ex_lon]]
        vector = [wp[0], wp[-1]] if len(wp) >= 2 else None
        # Офіційна зона тривоги — незалежне підтвердження: піднімає ефективну
        # впевненість (базова лишається як є для метрик корроборації каналів).
        eff_conf = min(0.99, self.confidence + (0.08 if self.in_zone else 0.0))
        return {
            "id": self.id,
            "type": self.type,
            "label": meta["label"],
            "color": meta["color"],
            "lat": self.ex_lat,
            "lon": self.ex_lon,
            "heading": self.heading,
            "speed_kmh": round(self._speed()),
            "destination": self.destination,
            "waypoints": wp,
            "vector": vector,
            "confidence": round(eff_conf, 2),
            "in_zone": self.in_zone,
            "zone_region": self.zone_region,
            "count": self.count,
            "source": self.source,
            "channel": self.channel,
            "raw": self.raw,
            "obs_count": self.obs_count,
            "sources": sorted(self.sources),
            "source_count": len(self.sources),
            "ts": self.last_obs_ts,
            "expires": self.last_obs_ts + TTL_BY_TYPE.get(self.type, 1500),
            "extrapolated": abs(self.ex_lat - self.lat) > 1e-6 or abs(self.ex_lon - self.lon) > 1e-6,
        }


class TrackManager:
    """Асоціює спостереження у треки та рухає їх у часі."""

    def __init__(self):
        self.tracks: dict[str, Track] = {}

    def _plausible_speed(self, t: Track, o: TacticalObject) -> float:
        return max(t._speed(), TYPE_META.get(o.type, TYPE_META["unknown"])["speed_kmh"])

    def observe(self, o: TacticalObject) -> Track:
        best: Track | None = None
        best_d = float("inf")
        for t in self.tracks.values():
            if not _compatible(t.type, o.type):
                continue
            dt_h = max(0.0, (o.ts - t.last_obs_ts)) / 3600.0
            gate = BASE_GATE_KM + self._plausible_speed(t, o) * dt_h * GATE_SPEED_FACTOR
            d = haversine_km((t.lat, t.lon), (o.lat, o.lon))
            if d <= gate and d < best_d:
                best, best_d = t, d
        if best is not None:
            self._update(best, o)
            return best
        return self._create(o)

    def _create(self, o: TacticalObject) -> Track:
        t = Track(
            id=o.id,
            type=o.type,
            lat=o.lat,
            lon=o.lon,
            source=o.source,
            channel=o.channel,
            raw=o.raw,
            destination=o.destination,
            heading=o.heading,
            confidence=o.confidence,
            count=o.count,
            first_ts=o.ts,
            last_obs_ts=o.ts,
            sources={o.channel or o.source},
            history=[(o.lat, o.lon, o.ts)],
            ex_lat=o.lat,
            ex_lon=o.lon,
        )
        self.tracks[t.id] = t
        return t

    def _update(self, t: Track, o: TacticalObject) -> None:
        # рухаємось лише вперед у часі
        if o.ts < t.last_obs_ts:
            return
        prev = (t.lat, t.lon, t.last_obs_ts)
        t.type = _merge_type(t.type, o.type)
        t.lat, t.lon = o.lat, o.lon
        t.ex_lat, t.ex_lon = o.lat, o.lon
        t.last_obs_ts = o.ts
        t.obs_count += 1
        t.count = max(t.count, o.count)
        t.sources.add(o.channel or o.source)
        if o.destination:
            t.destination = o.destination
        t.history.append((o.lat, o.lon, o.ts))
        if len(t.history) > 50:
            t.history = t.history[-50:]

        # згладжені курс/швидкість із фактичного зміщення
        if prev[2] < o.ts and haversine_km((prev[0], prev[1]), (o.lat, o.lon)) > 1:
            dist = haversine_km((prev[0], prev[1]), (o.lat, o.lon))
            dt_h = (o.ts - prev[2]) / 3600.0
            if dt_h > 0:
                spd = dist / dt_h
                lo, hi = 40, 4000
                t.speed_kmh = min(max(spd, lo), hi)
            t.heading = round(azimuth_deg((prev[0], prev[1]), (o.lat, o.lon)), 1)
        elif o.heading is not None:
            t.heading = o.heading
        # Корроборація: підтвердження НЕЗАЛЕЖНИМИ каналами важить більше, ніж
        # повтори з того самого джерела. Незалежні джерела складніше підробити.
        corroboration = 0.1 * (len(t.sources) - 1) + 0.02 * (t.obs_count - 1)
        t.confidence = min(0.99, max(t.confidence, o.confidence) + corroboration)

    def step(self, now: float | None = None) -> tuple[list[Track], list[str]]:
        """Екстраполює позиції; повертає (змінені треки, прострочені id)."""
        now = now or time.time()
        changed: list[Track] = []
        expired: list[str] = []
        for tid, t in list(self.tracks.items()):
            age = now - t.last_obs_ts
            if age > TTL_BY_TYPE.get(t.type, 1500):
                expired.append(tid)
                del self.tracks[tid]
                continue
            # затухання впевненості
            t.confidence = max(0.15, t.confidence - 0.0005 * (age / 60))
            if t.heading is None or age > MAX_EXTRAP_MIN * 60:
                continue
            dist_km = t._speed() * (age / 3600.0)
            nlat, nlon = move_point(t.lat, t.lon, t.heading, dist_km)
            if abs(nlat - t.ex_lat) > 1e-5 or abs(nlon - t.ex_lon) > 1e-5:
                t.ex_lat, t.ex_lon = nlat, nlon
                changed.append(t)
        return changed, expired
