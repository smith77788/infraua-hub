"""Гео-движок: нормалізація назв, пошук населених пунктів у тексті та
векторна математика (азимут/дистанція) між точками маршруту.

База даних генерується скриптом ``build_geodb.py`` з відкритого набору
GeoNames (populated places, Україна) і зберігається у SQLite ``geo.sqlite``.
"""

from __future__ import annotations

import math
import os
import re
import sqlite3
from dataclasses import dataclass

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "geo.sqlite")

# Символи-апострофи, які зустрічаються в українських назвах.
_APOS = "'’ʼ`´"
_PUNCT = re.compile(r"[^\w\sЀ-ӿ-]", re.UNICODE)
_SPACES = re.compile(r"\s+")


def normalize(name: str) -> str:
    """Нормалізує назву для зіставлення: нижній регістр, без апострофів/пунктуації."""
    s = name.lower().strip()
    for ch in _APOS:
        s = s.replace(ch, "")
    s = s.replace("ё", "е")  # ё -> е
    s = _PUNCT.sub(" ", s)
    s = _SPACES.sub(" ", s).strip()
    return s


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371.0
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1])
    la1 = math.radians(a[0])
    la2 = math.radians(b[0])
    h = math.sin(dlat / 2) ** 2 + math.sin(dlon / 2) ** 2 * math.cos(la1) * math.cos(la2)
    return 2 * r * math.asin(math.sqrt(h))


def azimuth_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Азимут напрямку з точки a на точку b, градуси 0..360 (0 = північ)."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def compass(deg: float) -> str:
    dirs = ["Пн", "ПнСх", "Сх", "ПдСх", "Пд", "ПдЗх", "Зх", "ПнЗх"]
    return dirs[int((deg + 22.5) % 360 // 45)]


def _decline_variants(key: str) -> list[str]:
    """Грубе зняття українських відмінкових закінчень для останнього слова.

    Приклади: «полтаву»→«полтава», «вінницю»→«вінниця», «харкові»→«харків»,
    «львова»→«львів» (спроба і↔о в основі не робиться, лише прості випадки).
    """
    parts = key.split()
    if not parts:
        return []
    last = parts[-1]
    cands: set[str] = set()

    def emit(stem: str) -> None:
        if len(stem) >= 3:
            cands.add(" ".join(parts[:-1] + [stem]))

    # жіночий рід -а/-я: знахідний (-у/-ю), родовий (-и/-і)
    if last.endswith(("у", "ю")):
        emit(last[:-1] + "а")
        emit(last[:-1] + "я")
    if last.endswith(("и", "і", "е")):
        emit(last[:-1] + "а")
        emit(last[:-1] + "я")
        emit(last[:-1])
    # чоловічий рід: родовий/місцевий (-а/-у/-і/-ові) з чергуванням о↔і
    if last.endswith(("ові", "еві")):
        emit(last[:-3] + "ів")  # харкові -> харків, львові -> львів
        emit(last[:-3])
    if last.endswith(("ом", "ем")):
        emit(last[:-2])
    if last.endswith("а"):
        emit(last[:-1] + "о")  # дніпра -> дніпро
    if last.endswith(("а", "у", "і")):
        emit(last[:-1])
    return [c for c in cands if c != key]


@dataclass
class Place:
    name: str
    lat: float
    lon: float
    pop: int


class GeoDB:
    """Індекс населених пунктів у памʼяті для швидкого пошуку в тексті."""

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self.index: dict[str, Place] = {}
        self.max_words = 3

    def load(self) -> "GeoDB":
        if not os.path.exists(self.db_path):
            raise FileNotFoundError(
                f"Гео-база не знайдена: {self.db_path}. Запустіть `python -m backend.build_geodb`."
            )
        con = sqlite3.connect(self.db_path)
        cur = con.execute("SELECT norm, display, lat, lon, pop FROM places")
        for norm, display, lat, lon, pop in cur:
            prev = self.index.get(norm)
            if prev is None or pop > prev.pop:
                self.index[norm] = Place(display, lat, lon, pop)
        con.close()
        return self

    def _resolve(self, key: str) -> Place | None:
        """Точний збіг або спроба зняти українське відмінкове закінчення."""
        place = self.index.get(key)
        if place is not None:
            return place
        for cand in _decline_variants(key):
            place = self.index.get(cand)
            if place is not None:
                return place
        return None

    def lookup(self, name: str) -> Place | None:
        return self._resolve(normalize(name))

    def find_places(self, text: str) -> list[Place]:
        """Знаходить згадані населені пункти: жадібний пошук n-грам (до 3 слів)."""
        words = normalize(text).split()
        found: list[Place] = []
        seen: set[str] = set()
        i = 0
        n = len(words)
        while i < n:
            matched = None
            span = 1
            for w in range(min(self.max_words, n - i), 0, -1):
                key = " ".join(words[i : i + w])
                if len(key) < 3:
                    continue
                place = self._resolve(key)
                if place is not None:
                    matched, span = place, w
                    break
            if matched is not None:
                if matched.name not in seen:
                    seen.add(matched.name)
                    found.append(matched)
                i += span
            else:
                i += 1
        return found
