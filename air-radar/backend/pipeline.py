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
from .models import DEFAULT_TTL_SEC, TacticalObject


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


def build_from_chain(
    chain,
    index: int,
    source: str = "detoyshahed",
    channel: str = "",
    ts: float | None = None,
    ttl: int | None = None,
    ttype: str = "unknown",
) -> TacticalObject:
    """Будує обʼєкт із ланцюга точок однієї доповіді (`reports.Chain`).

    Курс беремо з ланцюга (він виведений із двох і більше згаданих точок), а
    не з припущення. Позиція — остання згадана точка. Впевненість — базова
    за надійністю каналу (`sources`), а не однакова 0.9 для всіх.
    """
    from . import sources
    from .regions import nearest_oblast, oblast_of_display

    head = chain.head
    oblast = oblast_of_display(head.display_name)
    basis = "observed" if oblast else "unknown"
    if not oblast:
        oblast = nearest_oblast(head.lat, head.lon)
        basis = "inferred" if oblast else "unknown"
    return TacticalObject(
        id=chain.stable_id(index),
        type=ttype,
        lat=head.lat,
        lon=head.lon,
        source=source,
        channel=channel,
        raw=chain.route_label or head.name,
        heading=chain.heading,
        destination=head.name,
        waypoints=chain.waypoints,
        confidence=sources.base_confidence(channel),
        count=chain.count,
        ts=ts or time.time(),
        ttl=ttl if ttl is not None else DEFAULT_TTL_SEC,
        oblast=oblast,
        oblast_basis=basis,
        report_id=chain.report_id,
        report_siblings=chain.siblings,
        route=chain.route_label,
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
