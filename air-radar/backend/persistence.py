"""Персистентність: історія тактичних обʼєктів і подій у SQLite.

Дає радару памʼять (треки, аналітику, відтворення), чого немає в
чисто-клієнтських рішеннях. Записи потокобезпечні (блокування + окреме
зʼєднання на запис).
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "radar.sqlite")


class Store:
    def __init__(self, path: str = DB_PATH):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.path = path
        self._lock = threading.Lock()
        self._con = sqlite3.connect(path, check_same_thread=False)
        self._con.execute(
            """CREATE TABLE IF NOT EXISTS tracks (
                obj_id TEXT, type TEXT, lat REAL, lon REAL,
                heading REAL, confidence REAL, source TEXT, channel TEXT,
                raw TEXT, ts REAL
            )"""
        )
        self._con.execute("CREATE INDEX IF NOT EXISTS idx_tracks_ts ON tracks(ts)")
        self._con.execute("CREATE INDEX IF NOT EXISTS idx_tracks_obj ON tracks(obj_id)")
        self._con.commit()

    def record(self, obj) -> None:
        with self._lock:
            self._con.execute(
                "INSERT INTO tracks VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    obj.id, obj.type, obj.lat, obj.lon, obj.heading,
                    obj.confidence, obj.source, obj.channel, obj.raw[:500], obj.ts,
                ),
            )
            self._con.commit()

    def track(self, obj_id: str, limit: int = 200) -> list[dict]:
        with self._lock:
            cur = self._con.execute(
                "SELECT lat, lon, ts FROM tracks WHERE obj_id=? ORDER BY ts DESC LIMIT ?",
                (obj_id, limit),
            )
            return [{"lat": r[0], "lon": r[1], "ts": r[2]} for r in cur]

    def recent_paths(self, minutes: float = 60, max_points: int = 6000) -> dict[str, list[dict]]:
        """Треки за останні `minutes` хв, згруповані за obj_id — для реплею."""
        cutoff = time.time() - minutes * 60
        paths: dict[str, list[dict]] = {}
        with self._lock:
            cur = self._con.execute(
                "SELECT obj_id, lat, lon, ts FROM tracks WHERE ts>=? ORDER BY ts LIMIT ?",
                (cutoff, max_points),
            )
            for oid, lat, lon, ts in cur:
                paths.setdefault(oid, []).append({"lat": lat, "lon": lon, "ts": ts})
        return paths

    def stats(self, since_sec: float = 3600) -> dict:
        cutoff = time.time() - since_sec
        with self._lock:
            cur = self._con.execute(
                "SELECT type, COUNT(*) FROM tracks WHERE ts>=? GROUP BY type", (cutoff,)
            )
            by_type = {t: c for t, c in cur}
            total = self._con.execute(
                "SELECT COUNT(*) FROM tracks WHERE ts>=?", (cutoff,)
            ).fetchone()[0]
        return {"window_sec": since_sec, "total": total, "by_type": by_type}

    def export(self, since_sec: float = 86400) -> str:
        cutoff = time.time() - since_sec
        with self._lock:
            cur = self._con.execute(
                "SELECT obj_id,type,lat,lon,heading,confidence,source,channel,ts "
                "FROM tracks WHERE ts>=? ORDER BY ts",
                (cutoff,),
            )
            cols = [c[0] for c in cur.description]
            rows = [dict(zip(cols, r)) for r in cur]
        return json.dumps(rows, ensure_ascii=False)
