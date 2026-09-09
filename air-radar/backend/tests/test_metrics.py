"""Тести метрик спостережуваності (без мережі)."""

import time

from backend import metrics
from backend.broadcaster import Broadcaster
from backend.models import TacticalObject


def _obs(oid, lat, lon, channel, ttype="shahed", ts=None):
    return TacticalObject(
        id=oid, type=ttype, lat=lat, lon=lon, source="t", channel=channel,
        ts=ts or time.time(),
    )


def test_metrics_shape_and_corroboration():
    b = Broadcaster()
    t0 = time.time()
    # трек, підтверджений двома каналами
    b.tracks.observe(_obs("a", 49.0, 31.0, "chan_A", ts=t0))
    b.tracks.observe(_obs("b", 49.05, 31.0, "chan_B", ts=t0 + 120))
    # окремий трек з одним джерелом далеко
    b.tracks.observe(_obs("c", 46.5, 30.7, "chan_C", ts=t0))

    m = metrics.compute(b)
    assert m["tracks_total"] == 2
    assert m["corroboration"]["corroborated_tracks"] == 1
    assert 0 <= m["corroboration"]["corroborated_ratio"] <= 1
    assert set(m["confidence"]["buckets"]) == {"low", "med", "high"}
    assert "shahed" in m["by_type"]


def test_metrics_empty():
    m = metrics.compute(Broadcaster())
    assert m["tracks_total"] == 0
    assert m["confidence"]["avg"] == 0.0
    assert m["correlation"]["min_eta_min"] is None
