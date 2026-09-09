"""Генерація гео-бази для радара з відкритого набору GeoNames.

Завантажує архів населених пунктів України, витягує назви (українською/
латиницею та альтернативні варіанти) з координатами й будує індексований
SQLite ``data/geo.sqlite``.

Запуск:  python -m backend.build_geodb
"""

from __future__ import annotations

import io
import os
import sqlite3
import sys
import urllib.request
import zipfile

from .geocode import normalize

GEONAMES_URL = "https://download.geonames.org/export/dump/UA.zip"
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DATA_DIR, "geo.sqlite")

# Класи/коди GeoNames, які нас цікавлять (населені пункти).
POPULATED_CLASS = "P"
# Мінімальна довжина назви, щоб уникнути шуму.
MIN_LEN = 3


def _has_cyrillic(s: str) -> bool:
    return any("Ѐ" <= ch <= "ӿ" for ch in s)


_UK_LETTERS = set("іїєґ")
_NON_UK = set("ыэъёў")  # російські/білоруські маркери


def _uk_score(name: str) -> tuple[int, int]:
    """Оцінка «українськості» назви для вибору display (більше — краще)."""
    low = name.lower()
    score = sum(ch in _UK_LETTERS for ch in low) - 3 * sum(ch in _NON_UK for ch in low)
    return (score, len(name))


def download() -> bytes:
    print(f"[geodb] Завантаження {GEONAMES_URL} …", flush=True)
    req = urllib.request.Request(GEONAMES_URL, headers={"User-Agent": "air-radar/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def build(raw_zip: bytes) -> int:
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "CREATE TABLE places (norm TEXT, display TEXT, lat REAL, lon REAL, pop INTEGER)"
    )

    z = zipfile.ZipFile(io.BytesIO(raw_zip))
    text = z.read("UA.txt").decode("utf-8")

    rows: list[tuple[str, str, float, float, int]] = []
    seen: set[tuple[str, str]] = set()
    for line in text.splitlines():
        p = line.split("\t")
        if len(p) < 15 or p[6] != POPULATED_CLASS:
            continue
        try:
            lat, lon = float(p[4]), float(p[5])
            pop = int(p[14]) if p[14].isdigit() else 0
        except ValueError:
            continue
        # Кандидати назв: основна, ascii та альтернативні.
        names = {p[1], p[2]}
        cyr_candidates: list[str] = [p[1]] if _has_cyrillic(p[1]) else []
        for alt in p[3].split(","):
            alt = alt.strip()
            # відкидаємо коди/абревіатури та надто короткі
            if len(alt) >= MIN_LEN and (
                _has_cyrillic(alt) or (alt[:1].isupper() and " " not in alt)
            ):
                names.add(alt)
                if _has_cyrillic(alt):
                    cyr_candidates.append(alt)
        # Показуємо найбільш «українську» кириличну назву, якщо вона є.
        display = max(cyr_candidates, key=_uk_score) if cyr_candidates else p[1]
        for nm in names:
            norm = normalize(nm)
            if len(norm) < MIN_LEN:
                continue
            key = (norm, str(round(lat, 3)))
            if key in seen:
                continue
            seen.add(key)
            rows.append((norm, display, lat, lon, pop))

    con.executemany("INSERT INTO places VALUES (?,?,?,?,?)", rows)
    con.execute("CREATE INDEX idx_norm ON places(norm)")
    con.commit()
    total = con.execute("SELECT COUNT(*) FROM places").fetchone()[0]
    distinct = con.execute("SELECT COUNT(DISTINCT norm) FROM places").fetchone()[0]
    con.close()
    print(f"[geodb] Готово: {total} записів, {distinct} унікальних назв → {DB_PATH}", flush=True)
    return total


def main() -> int:
    try:
        raw = download()
    except Exception as exc:  # noqa: BLE001
        print(f"[geodb] ПОМИЛКА завантаження: {exc}", file=sys.stderr)
        return 1
    build(raw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
