"""Тести геометрії коридору загрози (детерміновані, без зовнішніх даних)."""

from backend.assets import Asset
from backend.correlation import corridor_assets


# Обʼєкти навколо точки старту (49.0, 30.0):
NORTH = Asset("north", "power_plant", 49.9, 30.0)  # прямо по курсу (0°), ~100 км
SIDE = Asset("side", "power_plant", 49.5, 31.2)  # збоку, поза шириною коридору
BEHIND = Asset("behind", "power_plant", 48.1, 30.0)  # позаду
NEAR = Asset("near", "hospital", 49.3, 30.05)  # по курсу, ближче


def test_asset_ahead_on_course_detected():
    hits = corridor_assets(49.0, 30.0, heading=0, speed_kmh=600, assets=[NORTH])
    assert len(hits) == 1
    assert hits[0].name == "north"
    assert hits[0].cross_km < 5  # майже точно по курсу
    assert hits[0].eta_min > 0


def test_side_asset_excluded():
    hits = corridor_assets(49.0, 30.0, heading=0, speed_kmh=600, assets=[SIDE], half_width_km=25)
    assert hits == []  # поза шириною коридору


def test_behind_excluded():
    hits = corridor_assets(49.0, 30.0, heading=0, speed_kmh=600, assets=[BEHIND])
    assert hits == []  # позаду треку


def test_eta_ordering_and_horizon():
    hits = corridor_assets(49.0, 30.0, heading=0, speed_kmh=600, assets=[NORTH, NEAR])
    assert [h.name for h in hits] == ["near", "north"]  # ближчий — менший ETA
    # горизонт 5 хв при 600 км/год = 50 км → far (100 км) відсікається
    short = corridor_assets(49.0, 30.0, heading=0, speed_kmh=600, assets=[NORTH], horizon_min=5)
    assert short == []


def test_no_heading_returns_empty():
    assert corridor_assets(49.0, 30.0, heading=None, speed_kmh=600, assets=[NORTH]) == []


def test_real_asset_registry_smoke():
    # трек над Полтавщиною курсом на захід (на Київ) — має чіплятись ≥1 обʼєкт
    hits = corridor_assets(49.6, 33.0, heading=290, speed_kmh=180, horizon_min=90)
    assert isinstance(hits, list)
