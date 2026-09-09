"""Тести движка предиктивних алертів і телеметрії екстрактора."""

import time

from backend.alerts_engine import evaluate, severity
from backend.extractor import extract
from backend.fusion import TrackManager
from backend.geocode import GeoDB
from backend.models import TacticalObject


def _track(conf=0.8, in_zone=False):
    tm = TrackManager()
    t = tm.observe(
        TacticalObject(id="t1", type="shahed", lat=47.5, lon=34.5, source="s", channel="c",
                       ts=time.time())
    )
    t.confidence = conf
    t.in_zone = in_zone
    return tm, t


def _hit(name="Запорізька АЕС", category="power_plant", eta=8.0):
    return {"name": name, "category": category, "category_label": "Електростанція",
            "eta_min": eta, "lat": 47.51, "lon": 34.58, "cross_km": 2.0, "along_km": 20.0}


def test_severity_levels():
    assert severity(8, "power_plant") == "critical"
    assert severity(18, "hospital") == "high"
    assert severity(25, "rail") == "medium"


def test_alert_raised_for_critical_asset():
    tm, t = _track(conf=0.8)
    alerts = evaluate(tm.tracks, {t.id: [_hit(eta=8)]})
    assert len(alerts) == 1
    assert alerts[0]["severity"] == "critical"
    assert alerts[0]["asset"] == "Запорізька АЕС"
    assert "ETA" in alerts[0]["reason"]


def test_low_confidence_suppressed():
    tm, t = _track(conf=0.4)
    assert evaluate(tm.tracks, {t.id: [_hit()]}) == []


def test_far_eta_suppressed():
    tm, t = _track(conf=0.8)
    assert evaluate(tm.tracks, {t.id: [_hit(eta=45)]}, max_eta=30) == []


def test_extractor_telemetry_tokens():
    geo = GeoDB().load()
    ex = extract("Шахед на висоті 1500 м, швидкістю 180 км/год, курс на Київ", geo)
    assert any(tok.startswith("alt:") for tok in ex.tokens)
    assert any(tok.startswith("spd:") for tok in ex.tokens)
    assert ex.destination and "Київ" in ex.destination
