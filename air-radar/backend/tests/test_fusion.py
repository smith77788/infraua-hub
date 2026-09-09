"""Тести Track Fusion + Motion Model (детерміновані, без зовнішніх даних)."""

import time

from backend.fusion import TrackManager, TTL_BY_TYPE
from backend.geocode import haversine_km
from backend.models import TacticalObject


def obs(oid, lat, lon, ts, ttype="shahed", heading=None, source="t", channel="c"):
    return TacticalObject(
        id=oid, type=ttype, lat=lat, lon=lon, source=source, channel=channel,
        heading=heading, ts=ts,
    )


def test_association_merges_close_sequential():
    tm = TrackManager()
    t0 = time.time()
    a = tm.observe(obs("a", 50.0, 30.0, t0))
    # ~15 км північніше через 5 хв — в межах гейту, той самий трек
    b = tm.observe(obs("b", 50.13, 30.0, t0 + 300))
    assert a.id == b.id
    assert len(tm.tracks) == 1
    assert b.obs_count == 2
    assert b.heading is not None and abs(b.heading) < 20  # рух на північ ≈ 0°


def test_distant_observations_are_separate():
    tm = TrackManager()
    t0 = time.time()
    tm.observe(obs("a", 50.0, 30.0, t0))
    tm.observe(obs("b", 46.5, 30.7, t0 + 60))  # Одеса — далеко
    assert len(tm.tracks) == 2


def test_unknown_merges_and_takes_type():
    tm = TrackManager()
    t0 = time.time()
    tm.observe(obs("a", 49.0, 31.0, t0, ttype="unknown"))
    t = tm.observe(obs("b", 49.05, 31.0, t0 + 120, ttype="shahed"))
    assert len(tm.tracks) == 1
    assert t.type == "shahed"  # конкретний тип перемагає невідомий


def test_motion_extrapolation():
    tm = TrackManager()
    t0 = time.time()
    tm.observe(obs("a", 49.0, 30.0, t0, ttype="shahed"))
    # друге спостереження задає курс на північ і швидкість
    tm.observe(obs("a2", 49.5, 30.0, t0 + 600))  # 600с, ~55.6 км → ~333 км/год
    tr = list(tm.tracks.values())[0]
    start = (tr.ex_lat, tr.ex_lon)
    # крок через 10 хв після останнього фіксу
    tm.step(now=tr.last_obs_ts + 600)
    moved = haversine_km(start, (tr.ex_lat, tr.ex_lon))
    assert moved > 20  # позиція реально просунулась вздовж курсу
    assert tr.ex_lat > start[0]  # на північ


def test_expiry():
    tm = TrackManager()
    t0 = time.time()
    tm.observe(obs("a", 49.0, 30.0, t0, ttype="ballistic"))
    changed, expired = tm.step(now=t0 + TTL_BY_TYPE["ballistic"] + 10)
    assert "a" in expired
    assert len(tm.tracks) == 0


def test_to_dict_shape():
    tm = TrackManager()
    tr = tm.observe(obs("a", 50.4, 30.5, time.time(), ttype="shahed", heading=90))
    d = tr.to_dict()
    for k in ("id", "type", "label", "color", "lat", "lon", "speed_kmh", "confidence", "obs_count"):
        assert k in d


def test_official_zone_boosts_confidence():
    tm = TrackManager()
    tr = tm.observe(obs("a", 49.5, 30.5, time.time(), ttype="shahed"))
    base = tr.to_dict()["confidence"]
    tr.in_zone = True
    tr.zone_region = "Область"
    boosted = tr.to_dict()
    assert boosted["confidence"] >= base
    assert boosted["in_zone"] is True
    assert boosted["zone_region"] == "Область"


def test_corroboration_by_independent_sources():
    t0 = time.time()
    # два підтвердження з РІЗНИХ каналів
    tm1 = TrackManager()
    tm1.observe(obs("a", 49.0, 31.0, t0, channel="chan_A"))
    multi = tm1.observe(obs("b", 49.05, 31.0, t0 + 120, channel="chan_B"))
    # два підтвердження з ОДНОГО каналу
    tm2 = TrackManager()
    tm2.observe(obs("a", 49.0, 31.0, t0, channel="chan_A"))
    single = tm2.observe(obs("b", 49.05, 31.0, t0 + 120, channel="chan_A"))
    assert multi.to_dict()["source_count"] == 2
    assert single.to_dict()["source_count"] == 1
    # незалежне підтвердження дає вищу впевненість
    assert multi.confidence > single.confidence
