"""Екстракційний рушій: з неструктурованого тексту OSINT-повідомлення дістає
тип цілі, маршрутні точки (waypoints), напрямок і рівень впевненості.

Реалізовано без важких ML-залежностей — лексикони + RegEx + гео-зіставлення.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .geocode import GeoDB, Place, azimuth_deg

# Порядок важливий: перевіряємо від найспецифічнішого типу до загального.
TYPE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("ballistic", re.compile(r"баліст|iskander|іскандер|кинджал|кинжал|kh-?47|х-?47", re.I)),
    ("kab", re.compile(r"\bкаб\b|каб-|умпк|керован(а|ої)\s+авіабомб", re.I)),
    ("cruise", re.compile(r"крилат|калібр|kalibr|kh-?101|х-?101|kh-?555|х-?555", re.I)),
    ("missile", re.compile(r"ракет|missile|c-?300|с-?300|onyx|онікс", re.I)),
    ("shahed", re.compile(r"шахед|shahed|герань|geran|мопед|бпла|дрон|uav|drone", re.I)),
    ("recon", re.compile(r"розвід|орлан|zala|supercam|розвідуваль", re.I)),
    ("aircraft", re.compile(r"\bміг\b|\bсу-?\d|бомбардувальн|тактичн(а|ої)\s+авіац|вильот", re.I)),
]

# Слова-напрямки → азимут (градуси).
DIRECTION_DEG: dict[str, float] = {
    "пн": 0, "північ": 0, "north": 0,
    "пнсх": 45, "північно-схід": 45,
    "сх": 90, "схід": 90, "east": 90,
    "пдсх": 135, "південно-схід": 135,
    "пд": 180, "південь": 180, "south": 180,
    "пдзх": 225, "південно-захід": 225,
    "зх": 270, "захід": 270, "west": 270,
    "пнзх": 315, "північно-захід": 315,
}
DIRECTION_RE = re.compile(
    r"на\s+(північ|південь|схід|захід|північно-схід|південно-схід|"
    r"північно-захід|південно-захід)",
    re.I,
)

# Маркери маршруту: «курс на X», «у напрямку X», «рухається на X».
COURSE_RE = re.compile(r"(?:курс(?:ом)?\s+на|напрям(?:ку|ок)?\s+на|прямує\s+на|рухається\s+на)\s+", re.I)
ORIGIN_RE = re.compile(r"(?:з боку|від|зі сторони)\s+", re.I)
COUNT_RE = re.compile(r"(\d+)\s*(?:х|x|шт|од|бпла|шахед|ракет|ціл)", re.I)


@dataclass
class Extraction:
    type: str
    places: list[Place]
    heading: float | None
    origin: str | None
    destination: str | None
    count: int
    confidence: float
    tokens: list[str] = field(default_factory=list)


def detect_type(text: str) -> tuple[str, str | None]:
    for name, pat in TYPE_PATTERNS:
        m = pat.search(text)
        if m:
            return name, m.group(0)
    return "unknown", None


def _course_target(text: str, geo: GeoDB) -> Place | None:
    m = COURSE_RE.search(text)
    if not m:
        return None
    tail = text[m.end() : m.end() + 40]
    places = geo.find_places(tail)
    return places[0] if places else None


def extract(text: str, geo: GeoDB) -> Extraction:
    text = " ".join(text.split())
    ttype, type_tok = detect_type(text)
    places = geo.find_places(text)
    tokens: list[str] = []
    if type_tok:
        tokens.append(type_tok.lower())

    # Кількість цілей.
    count = 1
    cm = COUNT_RE.search(text)
    if cm:
        try:
            count = max(1, int(cm.group(1)))
            tokens.append(f"count:{count}")
        except ValueError:
            pass
    if re.search(r"груп[аи]|рій|kolona|колон", text, re.I):
        tokens.append("group")

    # Пункт призначення за маркером курсу має пріоритет.
    dest_place = _course_target(text, geo)
    destination = dest_place.name if dest_place else None
    origin = places[0].name if places else None

    # Напрямок: спершу за явним словом, інакше — азимут між точками.
    heading: float | None = None
    dm = DIRECTION_RE.search(text)
    if dm:
        heading = DIRECTION_DEG.get(dm.group(1).lower())
        tokens.append(dm.group(0).lower())

    # Формуємо впорядкований список waypoints.
    ordered = list(places)
    if dest_place and dest_place not in ordered:
        ordered.append(dest_place)
    if dest_place and dest_place in ordered:
        ordered = [p for p in ordered if p != dest_place] + [dest_place]

    if heading is None and len(ordered) >= 2:
        a = (ordered[-2].lat, ordered[-2].lon)
        b = (ordered[-1].lat, ordered[-1].lon)
        heading = round(azimuth_deg(a, b), 1)

    if destination is None and len(ordered) >= 2:
        destination = ordered[-1].name
    if origin is None and len(ordered) >= 1:
        origin = ordered[0].name

    tokens.extend(p.name for p in ordered)

    # Впевненість: тип + к-сть точок + маршрут.
    conf = 0.25
    if ttype != "unknown":
        conf += 0.35
    if ordered:
        conf += 0.2
    if len(ordered) >= 2 or dest_place:
        conf += 0.2
    conf = round(min(conf, 0.99), 2)

    return Extraction(
        type=ttype,
        places=ordered,
        heading=heading,
        origin=origin,
        destination=destination,
        count=count,
        confidence=conf,
        tokens=tokens,
    )
