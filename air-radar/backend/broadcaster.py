"""Стан радара в памʼяті + широкомовлення у всі WebSocket-клієнти.

Тримає активні тактичні обʼєкти, зони тривог і потік OSINT-логів; розсилає
дельти підключеним клієнтам. Прибирання прострочених обʼєктів — фоновим циклом.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque

from .models import TacticalObject


class Broadcaster:
    def __init__(self, store=None):
        self.objects: dict[str, TacticalObject] = {}
        self.zones: list[dict] = []
        self.logs: deque[dict] = deque(maxlen=300)
        self.clients: set = set()
        self.store = store
        self._lock = asyncio.Lock()

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
            "objects": [o.to_dict() for o in self.objects.values()],
            "zones": self.zones,
            "logs": list(self.logs)[-80:],
            "ts": time.time(),
        }

    async def upsert(self, obj: TacticalObject) -> None:
        async with self._lock:
            self.objects[obj.id] = obj
        if self.store:
            try:
                self.store.record(obj)
            except Exception:  # noqa: BLE001
                pass
        await self._emit({"type": "upsert", "object": obj.to_dict()})

    async def remove(self, obj_id: str) -> None:
        async with self._lock:
            self.objects.pop(obj_id, None)
        await self._emit({"type": "remove", "id": obj_id})

    async def set_zones(self, zones: list[dict]) -> None:
        self.zones = zones
        await self._emit({"type": "zones", "zones": zones})

    async def log(self, entry: dict) -> None:
        entry.setdefault("ts", time.time())
        self.logs.append(entry)
        await self._emit({"type": "log", "log": entry})

    # ── фонове прибирання ────────────────────────────────────────────────
    async def sweeper(self, interval: int = 30) -> None:
        while True:
            await asyncio.sleep(interval)
            now = time.time()
            expired = [oid for oid, o in list(self.objects.items()) if o.expired(now)]
            for oid in expired:
                await self.remove(oid)
