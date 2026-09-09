"""Observability: зведені метрики якості та стану платформи.

Дає governance-погляд на систему: скільки треків підтверджено незалежними
джерелами (корроборація), розподіл впевненості й типів, скільки рухомих
треків і скільки корелює з обʼєктами. Використовується `/api/metrics`.
"""

from __future__ import annotations

import time


def compute(broadcaster) -> dict:
    tracks = list(broadcaster.tracks.tracks.values())
    n = len(tracks)
    by_type: dict[str, int] = {}
    src_dist = {"1": 0, "2": 0, "3+": 0}
    conf_sum = 0.0
    conf_buckets = {"low": 0, "med": 0, "high": 0}
    moving = 0
    corroborated = 0
    in_zone = 0
    for t in tracks:
        by_type[t.type] = by_type.get(t.type, 0) + 1
        sc = len(t.sources)
        src_dist["1" if sc <= 1 else "2" if sc == 2 else "3+"] += 1
        if sc >= 2:
            corroborated += 1
        conf_sum += t.confidence
        conf_buckets["low" if t.confidence < 0.5 else "med" if t.confidence < 0.8 else "high"] += 1
        if t.heading is not None:
            moving += 1
        if t.in_zone:
            in_zone += 1

    threatened_tracks = len(broadcaster.threatened)
    threatened_assets = set()
    min_eta = None
    for hits in broadcaster.threatened.values():
        for h in hits:
            threatened_assets.add(h["name"])
            eta = h["eta_min"]
            min_eta = eta if min_eta is None else min(min_eta, eta)

    return {
        "ts": time.time(),
        "tracks_total": n,
        "moving_tracks": moving,
        "by_type": by_type,
        "confidence": {
            "avg": round(conf_sum / n, 3) if n else 0.0,
            "buckets": conf_buckets,
        },
        "corroboration": {
            "source_distribution": src_dist,
            "corroborated_tracks": corroborated,
            "corroborated_ratio": round(corroborated / n, 3) if n else 0.0,
            "in_official_zone": in_zone,
        },
        "correlation": {
            "threatened_tracks": threatened_tracks,
            "threatened_assets": len(threatened_assets),
            "min_eta_min": round(min_eta, 1) if min_eta is not None else None,
        },
        "zones_active": len(broadcaster.zones),
        "clients": len(broadcaster.clients),
    }
