"""Стан радара (треки після фьюжну) + широкомовлення у WebSocket-клієнти.

Джерело істини — TrackManager: сирі спостереження проходять асоціацію у треки,
фоновий motion-крок екстраполює їх у часі та розсилає оновлення позицій.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque

from .assets import ASSETS, CATEGORY_LABEL
from .correlation import correlate_tracks
from .fusion import TrackManager
from .models import TacticalObject

ASSET_LIST = [
    {"name": a.name, "category": a.category, "category_label": CATEGORY_LABEL.get(a.category, a.category), "lat": a.lat, "lon": a.lon}
    for a in ASSETS
]


class Broadcaster:
    def __init__(self, store=None):
        self.tracks = TrackManager()
        self.zones: list[dict] = []
        self.logs: deque[dict] = deque(maxlen=300)
        self.threatened: dict[str, list[dict]] = {}
        self.clients: set = set()
        self.store = store
        self._lock = asyncio.Lock()

    @property
    def object_count(self) -> int:
        return len(self.tracks.tracks)

    # ── клієнти ──────────────────────────────────────────────────────────
    async def connect(self, ws) -> None:
        await ws.accept()
        self.clients.add(ws)
        await ws.send_json(self.snapshot())

    def disconnect(self, ws) -> None:
        self.clients.discard(ws)

    async def _emit(self, msg: dict) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(msg)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    # ── стан ─────────────────────────────────────────────────────────────
    def snapshot(self) -> dict:
        return {
            "type": "snapshot",
            "objects": [t.to_dict() for t in self.tracks.tracks.values()],
            "zones": self.zones,
            "assets": ASSET_LIST,
            "threatened": self.threatened,
            "logs": list(self.logs)[-80:],
            "ts": time.time(),
        }

    async def observe(self, obj: TacticalObject) -> None:
        """Приймає сире спостереження, проганяє через фьюжн і транслює трек."""
        async with self._lock:
            track = self.tracks.observe(obj)
        if self.store:
            try:
                self.store.record(obj)
            except Exception:  # noqa: BLE001
                pass
        await self._emit({"type": "upsert", "object": track.to_dict()})

    async def remove(self, obj_id: str) -> None:
        await self._emit({"type": "remove", "id": obj_id})

    async def set_zones(self, zones: list[dict]) -> None:
        self.zones = zones
        await self._emit({"type": "zones", "zones": zones})

    async def log(self, entry: dict) -> None:
        entry.setdefault("ts", time.time())
        self.logs.append(entry)
        await self._emit({"type": "log", "log": entry})

    # ── motion + прибирання ──────────────────────────────────────────────
    async def motion_loop(self, interval: int = 3) -> None:
        while True:
            await asyncio.sleep(interval)
            async with self._lock:
                changed, expired = self.tracks.step()
                # Крос-перевірка треків з офіційними зонами тривог (незалежний сигнал).
                if self.zones:
                    from .geometry import zone_containing

                    for t in self.tracks.tracks.values():
                        region = zone_containing(t.ex_lat, t.ex_lon, self.zones)
                        t.in_zone = region is not None
                        t.zone_region = region
                # Кореляція «загроза → обʼєкт» по всіх рухомих треках.
                self.threatened = correlate_tracks(list(self.tracks.tracks.values()))
            for t in changed:
                await self._emit({"type": "upsert", "object": t.to_dict()})
            for tid in expired:
                await self.remove(tid)
            await self._emit({"type": "threatened", "threatened": self.threatened})
