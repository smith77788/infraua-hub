"""Threat → Asset correlation — предиктивний примітив (розроблено в проєкті).

Для рухомого треку (позиція + курс + швидкість) проєктує «коридор загрози»
вперед на горизонт часу і знаходить обʼєкти інфраструктури в ньому: рахує
поперечне відхилення від курсу (cross-track), відстань уздовж курсу
(along-track) та ETA. Дає перехід від реактивної до предиктивної обізнаності.

Перевірено юніт-тестами (геометрія коридору детермінована).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .assets import ASSETS, CATEGORY_LABEL, Asset

R_KM = 6371.0


def _cross_track_km(
    pos: tuple[float, float], heading: float, asset: tuple[float, float]
) -> tuple[float, float]:
    """Повертає (cross_track_km, along_track_km) обʼєкта відносно курсу з pos."""
    from .geocode import azimuth_deg, haversine_km

    d13 = haversine_km(pos, asset)
    if d13 == 0:
        return 0.0, 0.0
    theta13 = math.radians(azimuth_deg(pos, asset))
    brng = math.radians(heading)
    dxt = math.asin(max(-1.0, min(1.0, math.sin(d13 / R_KM) * math.sin(theta13 - brng)))) * R_KM
    # along-track
    cos_dat = math.cos(d13 / R_KM) / max(1e-9, math.cos(dxt / R_KM))
    dat = math.acos(max(-1.0, min(1.0, cos_dat))) * R_KM
    return dxt, dat


@dataclass
class ThreatenedAsset:
    name: str
    category: str
    category_label: str
    lat: float
    lon: float
    cross_km: float
    along_km: float
    eta_min: float

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "category": self.category,
            "category_label": self.category_label,
            "lat": self.lat,
            "lon": self.lon,
            "cross_km": round(self.cross_km, 1),
            "along_km": round(self.along_km, 1),
            "eta_min": round(self.eta_min, 1),
        }


def corridor_assets(
    lat: float,
    lon: float,
    heading: float | None,
    speed_kmh: float,
    assets: list[Asset] | None = None,
    half_width_km: float = 25.0,
    horizon_min: float = 35.0,
) -> list[ThreatenedAsset]:
    """Обʼєкти в коридорі загрози попереду треку, відсортовані за ETA."""
    if heading is None or speed_kmh <= 0:
        return []
    from .geocode import haversine_km

    assets = assets if assets is not None else ASSETS
    pos = (lat, lon)
    horizon_km = speed_kmh * horizon_min / 60.0
    out: list[ThreatenedAsset] = []
    for a in assets:
        ap = (a.lat, a.lon)
        d13 = haversine_km(pos, ap)
        if d13 > horizon_km + half_width_km:
            continue
        dxt, dat = _cross_track_km(pos, heading, ap)
        if abs(dxt) > half_width_km or dat > horizon_km:
            continue
        # обʼєкт має бути попереду (в межах ±90° від курсу)
        from .geocode import azimuth_deg

        ang = abs(((azimuth_deg(pos, ap) - heading + 180) % 360) - 180)
        if ang > 90:
            continue
        out.append(
            ThreatenedAsset(
                name=a.name,
                category=a.category,
                category_label=CATEGORY_LABEL.get(a.category, a.category),
                lat=a.lat,
                lon=a.lon,
                cross_km=abs(dxt),
                along_km=dat,
                eta_min=dat / speed_kmh * 60.0,
            )
        )
    out.sort(key=lambda x: x.eta_min)
    return out


def correlate_tracks(tracks: list, assets: list[Asset] | None = None) -> dict[str, list[dict]]:
    """Для кожного рухомого треку — перелік обʼєктів у його коридорі загрози."""
    result: dict[str, list[dict]] = {}
    for t in tracks:
        hits = corridor_assets(t.ex_lat, t.ex_lon, t.heading, t._speed(), assets)
        if hits:
            result[t.id] = [h.to_dict() for h in hits]
    return result
