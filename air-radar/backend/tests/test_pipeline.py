"""Юніт-тести гео-движка, екстрактора та конвеєра.

Вхідні рядки — приклади РЕАЛЬНИХ форматів OSINT-повідомлень (не вигадані
факти, а типові формулювання), щоб перевірити коректність розбору.
"""

import math

import pytest

from backend.geocode import GeoDB, azimuth_deg, haversine_km, normalize
from backend.extractor import extract, detect_type
from backend.pipeline import build_from_message


@pytest.fixture(scope="module")
def geo():
    return GeoDB().load()


def test_normalize():
    assert normalize("Кремінна’") == "кремінна"
    assert normalize("  Біла   Церква ") == "біла церква"


def test_geo_basic(geo):
    p = geo.lookup("Київ")
    assert p is not None
    assert abs(p.lat - 50.45) < 0.2 and abs(p.lon - 30.52) < 0.2


def test_geo_declension(geo):
    # знахідний/родовий відмінки мають резолвитись у номінатив
    for word in ["Полтаву", "Дніпра", "Вінницю", "Харкові"]:
        assert geo.lookup(word) is not None, word


def test_find_route(geo):
    places = geo.find_places("БпЛА Суми - Ромни - Прилуки, курс на Київ")
    names = [p.name for p in places]
    assert "Суми" in names and "Прилуки" in names


def test_azimuth_math():
    # рух з півдня на північ ≈ 0°, на схід ≈ 90°
    assert abs(azimuth_deg((49.0, 30.0), (50.0, 30.0))) < 5
    assert abs(azimuth_deg((50.0, 30.0), (50.0, 32.0)) - 90) < 5
    assert haversine_km((50.45, 30.52), (49.84, 24.03)) > 400  # Київ-Львів


def test_detect_type():
    assert detect_type("Шахеди курсом на місто")[0] == "shahed"
    assert detect_type("Загроза балістики зі сходу")[0] == "ballistic"
    assert detect_type("Пуск крилатих ракет")[0] == "cruise"
    assert detect_type("Розвідувальний БпЛА Орлан")[0] in ("recon", "shahed")


def test_extract_full(geo):
    ex = extract("Група Shahed на Полтавщині, курс на Кременчук", geo)
    assert ex.type == "shahed"
    assert ex.destination is not None
    assert ex.confidence > 0.5
    assert "group" in ex.tokens or ex.count >= 1


def test_build_object(geo):
    obj = build_from_message(
        "Шахеди Суми у напрямку на Полтаву", geo, source="telegram", channel="test"
    )
    assert obj is not None
    assert obj.type == "shahed"
    assert obj.lat and obj.lon
    assert obj.id and len(obj.id) == 16
    d = obj.to_dict()
    assert d["label"] and d["color"] and d["speed_kmh"] > 0


def test_build_object_no_geo(geo):
    assert build_from_message("невідоме повідомлення без локацій", geo) is None


def test_stable_id(geo):
    a = build_from_message("Шахед на Київ", geo, channel="c1")
    b = build_from_message("Шахед на Київ", geo, channel="c1")
    assert a.id == b.id  # дедуплікація
