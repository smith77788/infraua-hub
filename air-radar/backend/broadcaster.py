"""Стан радара (треки після фьюжну) + широкомовлення у WebSocket-клієнти.

Джерело істини — TrackManager: сирі спостереження проходять асоціацію у треки,
фоновий motion-крок екстраполює їх у часі та розсилає оновлення позицій.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque

from .fusion import TrackManager
from .models import TacticalObject


class Broadcaster:
    def __init__(self, store=None):
        self.tracks = TrackManager()
        self.zones: list[dict] = []
        self.logs: deque[dict] = deque(maxlen=300)
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
            for t in changed:
                await self._emit({"type": "upsert", "object": t.to_dict()})
            for tid in expired:
                await self.remove(tid)
