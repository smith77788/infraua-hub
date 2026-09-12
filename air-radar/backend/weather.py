"""Приземний вітер із open-meteo (keyless, перевірено запитом 12.09.2026).

Потрібен рівно для однієї речі — оцінки зносу уламків вітром. Запити
кешуються за округленою координатою: вітер не міняється щосекунди, а
стороннє джерело не має отримувати запит на кожен рух миші.
"""

from __future__ import annotations

import time

import aiohttp

URL = "https://api.open-meteo.com/v1/forecast"
CACHE_TTL = 600  # 10 хв
_cache: dict[tuple, tuple[float, dict]] = {}


async def current_wind(lat: float, lon: float) -> dict | None:
    key = (round(lat, 1), round(lon, 1))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    params = {
        "latitude": key[0],
        "longitude": key[1],
        "current": "wind_speed_10m,wind_direction_10m",
        "wind_speed_unit": "ms",
    }
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(URL, params=params, timeout=aiohttp.ClientTimeout(total=12)) as r:
                if r.status != 200:
                    return None
                data = await r.json(content_type=None)
    except Exception:  # noqa: BLE001
        return None
    cur = (data or {}).get("current") or {}
    if "wind_speed_10m" not in cur:
        return None
    out = {
        "speed_ms": float(cur["wind_speed_10m"]),
        "direction_deg": float(cur.get("wind_direction_10m") or 0),
        "observed_at": cur.get("time"),
        "source": "open-meteo",
    }
    _cache[key] = (time.time(), out)
    return out
