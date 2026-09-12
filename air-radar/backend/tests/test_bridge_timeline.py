"""Час події береться з джерела, а не з «зараз» — і все інше на цьому тримається."""

import time

from backend.bridge_detoyshahed import (
    group_reports,
    merc_to_latlon,
    observations,
    parse_ts,
    parse_zones,
)

# Форма запису — з живої видачі detoyshahed (перевірено 12.09.2026).
def _inc(iid, rid, name, x, y, channel, created, expires, display=""):
    return {
        "id": iid,
        "report_id": rid,
        "location_name": name,
        "display_name": display or f"{name}, Рівненська область",
        "coordinates": {"lat": y, "lng": x},
        "channel_name": channel,
        "count": 1,
        "created_at": created,
        "expires_at": expires,
    }


OLD = _inc("i1", "r1", "Рівне", 2922000.0, 6560000.0, "kpszsu",
           "2026-09-12T17:00:00.000Z", "2026-09-12T19:00:00.000Z")


def test_timestamp_comes_from_source_not_now():
    (obj, _log), = observations([OLD])
    assert obj.ts == parse_ts("2026-09-12T17:00:00.000Z")
    assert abs(obj.ts - time.time()) > 1000  # саме в цьому й була помилка


def test_ttl_comes_from_source_window():
    (obj, _log), = observations([OLD])
    assert obj.ttl == 2 * 60 * 60


def test_broken_timestamp_does_not_crash_ingest():
    bad = dict(OLD, created_at="не-дата", expires_at=None)
    (obj, _log), = observations([bad])
    assert obj.ts > 0  # падає назад на «зараз», а не валить конвеєр


def test_confidence_follows_source_reliability():
    (official, _), = observations([OLD])
    (monitor, _), = observations([dict(OLD, channel_name="radar_top_ua")])
    assert official.confidence > monitor.confidence


def test_oblast_is_observed_from_admin_chain():
    (obj, _log), = observations([OLD])
    assert obj.oblast == "Рівненська область"
    assert obj.oblast_basis == "observed"


def test_report_grouping_preserves_mention_order():
    g = group_reports([OLD, dict(OLD, id="i2", location_name="Гоща")])
    assert list(g) == ["r1"]
    assert [i["location_name"] for i in g["r1"]] == ["Рівне", "Гоща"]


def test_mercator_conversion_lands_in_ukraine():
    lat, lon = merc_to_latlon(3483669.10, 6709163.92)  # Чернігів із видачі
    assert 51.0 < lat < 52.0 and 30.5 < lon < 32.0


def test_zone_parsing_survives_missing_geometry():
    assert parse_zones(None) == []
    assert parse_zones({"alerts": [{"region_name": "X", "geometry": {}}]}) == []
