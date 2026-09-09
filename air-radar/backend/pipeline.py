"""Конвеєр: сире повідомлення → екстракція → геокодування → TacticalObject.

Єдина точка перетворення будь-якого джерела (Telegram, bridge) у структурований
тактичний обʼєкт. Стабільний id дозволяє дедуплікацію та оновлення треку.
"""

from __future__ import annotations

import hashlib
import re
import time

from .extractor import extract
from .geocode import GeoDB
from .models import TacticalObject


def _stable_id(channel: str, text: str, place: str) -> str:
    key = f"{channel}|{place}|{re.sub(r'[^а-яіїєґa-z0-9]', '', text.lower())[:60]}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def build_from_message(
    raw: str, geo: GeoDB, source: str = "telegram", channel: str = "", ts: float | None = None
) -> TacticalObject | None:
    """Будує тактичний обʼєкт із сирого OSINT-повідомлення. None, якщо без гео."""
    ex = extract(raw, geo)
    if not ex.places:
        return None
    # Поточна позиція = остання відома точка (не пункт призначення), щоб мати ETA.
    if ex.destination and len(ex.places) >= 2 and ex.places[-1].name == ex.destination:
        pos = ex.places[-2]
    else:
        pos = ex.places[-1]
    obj_id = _stable_id(channel or source, raw, pos.name)
    return TacticalObject(
        id=obj_id,
        type=ex.type,
        lat=pos.lat,
        lon=pos.lon,
        source=source,
        channel=channel,
        raw=raw,
        heading=ex.heading,
        origin=ex.origin,
        destination=ex.destination,
        waypoints=[[p.lat, p.lon] for p in ex.places],
        confidence=ex.confidence,
        count=ex.count,
        ts=ts or time.time(),
    )


def build_from_point(
    obj_id: str,
    name: str,
    lat: float,
    lon: float,
    source: str,
    channel: str = "",
    ts: float | None = None,
    ttype: str = "unknown",
) -> TacticalObject:
    """Будує обʼєкт із вже геокодованої точки (bridge реальних інцидентів)."""
    return TacticalObject(
        id=obj_id,
        type=ttype,
        lat=lat,
        lon=lon,
        source=source,
        channel=channel,
        raw=name,
        destination=name,
        waypoints=[[lat, lon]],
        confidence=0.9,
        ts=ts or time.time(),
    )
