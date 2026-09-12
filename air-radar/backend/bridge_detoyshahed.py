"""Bridge до відкритого OSINT-джерела detoyshahed.in.ua.

Дає радару РЕАЛЬНІ дані (позиції повітряних цілей + полігони активних тривог)
без облікових даних Telegram — джерело саме парсить публічні Telegram-канали.

Що тут виправлено (і чому це було важливо).

1. ЧАС ПОДІЇ. Раніше кожен інцидент отримував мітку «зараз», хоч джерело
   тримає інцидент активним 2 години і віддає власний `created_at`. Наслідок
   був не косметичний: радар показував 140 «активних цілей», з яких (заміряно
   12.09.2026) лише 11 молодші за 10 хвилин, а 91 — старші за годину. Фьюжн
   вважав дворічної давнини… тобто двогодинної давнини фікс щойно отриманим,
   dead-reckoning не рухав трек, а TTL не спрацьовував. Тепер час беремо з
   джерела, а TTL — із його ж `expires_at`.

2. ДОПОВІДЬ. `report_id` (одне вихідне повідомлення каналу) не
   використовувався взагалі. Тепер інциденти групуються за доповіддю і
   ріжуться на географічно когерентні ланцюги (`reports.py`): близькі точки
   дають курс і маршрут, далекі лишаються різними цілями однієї хвилі.

3. ДЖЕРЕЛО. Усі канали важили 0.9. Тепер базова впевненість — за надійністю
   каналу (`sources.py`), офіційний канал вище за анонімний монітор.

4. ОБЛАСТЬ. `display_name` несе адміністративний ланцюг — звідси прив'язка
   цілі до області для зведення обстановки та звірки з другим джерелом.
"""

from __future__ import annotations

import asyncio
import math
from datetime import datetime, timezone

import aiohttp

INCIDENTS_URL = "https://detoyshahed.in.ua/api/incidents/active"
ALERTS_URL = "https://detoyshahed.in.ua/api/alerts/active"

# Верхня межа TTL із джерела: воно тримає інцидент 2 год, але для повітряної
# цілі це вже не «зараз». Далі рішення ухвалює TTL за типом у fusion.py.
MAX_SOURCE_TTL_SEC = 2 * 60 * 60


def merc_to_latlon(x: float, y: float) -> tuple[float, float]:
    lon = x / 20037508.34 * 180
    lat = y / 20037508.34 * 180
    lat = 180 / math.pi * (2 * math.atan(math.exp(lat * math.pi / 180)) - math.pi / 2)
    return lat, lon


def parse_ts(value: str | None) -> float | None:
    """ISO-8601 із джерела → unix. None, якщо поля немає або воно зіпсоване."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None


def _decimate(ring: list, step_target: int = 120) -> list[list[float]]:
    step = max(1, len(ring) // step_target)
    out = []
    for i in range(0, len(ring), step):
        p = ring[i]
        if isinstance(p, list) and len(p) >= 2:
            out.append([p[1], p[0]])  # [lon,lat] -> [lat,lon]
    return out


async def _fetch_json(session: aiohttp.ClientSession, url: str) -> dict | None:
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status != 200:
                return None
            return await r.json(content_type=None)
    except Exception:  # noqa: BLE001
        return None


def group_reports(incidents: list[dict]) -> dict[str, list[dict]]:
    """Інциденти за `report_id`, зі збереженням порядку згадування."""
    groups: dict[str, list[dict]] = {}
    for it in incidents:
        rid = str(it.get("report_id") or it.get("id") or "")
        groups.setdefault(rid, []).append(it)
    return groups


def observations(incidents: list[dict]) -> list[tuple]:
    """Сирі інциденти → (TacticalObject, log_entry) за доповідями й ланцюгами.

    Чиста функція: жодної мережі й жодного часу «зараз» — усе з даних.
    """
    from .pipeline import build_from_chain
    from .reports import ReportPoint, chains_of_report
    from . import sources

    out: list[tuple] = []
    for rid, items in group_reports(incidents).items():
        points: list[ReportPoint] = []
        channel = ""
        created = None
        ttl = None
        for it in items:
            c = it.get("coordinates") or {}
            if "lat" not in c or "lng" not in c:
                continue
            lat, lon = merc_to_latlon(c["lng"], c["lat"])
            points.append(
                ReportPoint(
                    name=it.get("location_name") or "Ціль",
                    lat=lat,
                    lon=lon,
                    incident_id=str(it.get("id") or ""),
                    display_name=it.get("display_name") or "",
                    count=int(it.get("count") or 1),
                )
            )
            channel = channel or (it.get("channel_name") or "OSINT")
            created = created or parse_ts(it.get("created_at"))
            exp = parse_ts(it.get("expires_at"))
            if ttl is None and exp and created:
                ttl = min(MAX_SOURCE_TTL_SEC, max(60, int(exp - created)))
        if not points:
            continue
        for idx, chain in enumerate(chains_of_report(rid, points)):
            obj = build_from_chain(chain, idx, channel=channel, ts=created, ttl=ttl)
            prof = sources.profile(channel)
            log = {
                "channel": channel,
                "text": chain.route_label or chain.head.name,
                "confidence": obj.confidence,
                "tokens": [p.name for p in chain.points],
                "source": "detoyshahed",
                "tier": prof.tier_label,
                "reliability": prof.reliability,
                "oblast": obj.oblast,
                "ts": obj.ts,
            }
            out.append((obj, log))
    return out


def parse_zones(payload: dict | None) -> list[dict]:
    """Полігони активних тривог із відповіді джерела."""
    if not payload or not isinstance(payload.get("alerts"), list):
        return []
    zones = []
    for a in payload["alerts"]:
        g = a.get("geometry") or {}
        coords = g.get("coordinates")
        polys: list[list[list[float]]] = []
        if g.get("type") == "Polygon" and coords:
            polys.append(_decimate(coords[0]))
        elif g.get("type") == "MultiPolygon" and coords:
            for poly in coords:
                if poly:
                    polys.append(_decimate(poly[0]))
        if polys:
            zones.append(
                {
                    "region": a.get("region_name", "Регіон"),
                    "type": a.get("region_type", ""),
                    "polygons": polys,
                }
            )
    return zones


async def run_bridge(broadcaster, pipeline, poll_sec: int = 20) -> None:
    seen: set[str] = set()
    async with aiohttp.ClientSession(headers={"User-Agent": "air-radar/1.0"}) as session:
        while True:
            inc = await _fetch_json(session, INCIDENTS_URL)
            if inc and isinstance(inc.get("incidents"), list):
                for obj, log in observations(inc["incidents"]):
                    await broadcaster.observe(obj)
                    if obj.id not in seen:
                        seen.add(obj.id)
                        await broadcaster.log(log)
                if len(seen) > 5000:
                    seen.clear()

            zones = parse_zones(await _fetch_json(session, ALERTS_URL))
            if zones:
                await broadcaster.set_zones(zones)

            await asyncio.sleep(poll_sec)
