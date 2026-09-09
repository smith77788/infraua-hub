"""Bridge до відкритого OSINT-джерела detoyshahed.in.ua.

Дає радару РЕАЛЬНІ дані (позиції повітряних цілей + полігони активних тривог)
без облікових даних Telegram — джерело саме парсить публічні Telegram-канали.
Використовується як живий потік, доки не підключено власний Telethon-інжест.
"""

from __future__ import annotations

import asyncio
import math

import aiohttp

INCIDENTS_URL = "https://detoyshahed.in.ua/api/incidents/active"
ALERTS_URL = "https://detoyshahed.in.ua/api/alerts/active"


def merc_to_latlon(x: float, y: float) -> tuple[float, float]:
    lon = x / 20037508.34 * 180
    lat = y / 20037508.34 * 180
    lat = 180 / math.pi * (2 * math.atan(math.exp(lat * math.pi / 180)) - math.pi / 2)
    return lat, lon


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


async def run_bridge(broadcaster, pipeline, poll_sec: int = 20) -> None:
    from .pipeline import build_from_point

    seen: set[str] = set()
    async with aiohttp.ClientSession(headers={"User-Agent": "air-radar/1.0"}) as session:
        while True:
            inc = await _fetch_json(session, INCIDENTS_URL)
            if inc and isinstance(inc.get("incidents"), list):
                for it in inc["incidents"]:
                    c = it.get("coordinates") or {}
                    if "lat" not in c or "lng" not in c:
                        continue
                    lat, lon = merc_to_latlon(c["lng"], c["lat"])
                    oid = str(it.get("id"))
                    name = it.get("location_name") or "Ціль"
                    channel = it.get("channel_name") or "OSINT"
                    obj = build_from_point(
                        oid, name, lat, lon, source="detoyshahed", channel=channel, ttype="unknown"
                    )
                    await broadcaster.upsert(obj)
                    if oid not in seen:
                        seen.add(oid)
                        await broadcaster.log(
                            {
                                "channel": channel,
                                "text": f"Ціль: {name}",
                                "confidence": 0.9,
                                "tokens": [name],
                                "source": "detoyshahed",
                            }
                        )

            zon = await _fetch_json(session, ALERTS_URL)
            if zon and isinstance(zon.get("alerts"), list):
                zones = []
                for a in zon["alerts"]:
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
                await broadcaster.set_zones(zones)

            await asyncio.sleep(poll_sec)
