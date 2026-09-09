"""FastAPI-сервер тактичного радара: WebSocket-стрім, REST API та статика COP.

Життєвий цикл піднімає джерела даних (bridge + опційно Telethon) і фонове
прибирання прострочених обʼєктів.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .broadcaster import Broadcaster
from .config import settings
from .geocode import GeoDB
from .persistence import Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("radar")

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")

store = Store()
geo = GeoDB()
broadcaster = Broadcaster(store=store)
_tasks: list[asyncio.Task] = []


async def _lifespan(app: FastAPI):  # noqa: ANN201
    geo.load()
    log.info("Гео-база завантажена: %d назв", len(geo.index))
    _tasks.append(asyncio.create_task(broadcaster.motion_loop()))
    if settings.enable_bridge:
        from .bridge_detoyshahed import run_bridge

        _tasks.append(
            asyncio.create_task(run_bridge(broadcaster, None, settings.bridge_poll_sec))
        )
        log.info("Bridge detoyshahed увімкнено (кожні %d c)", settings.bridge_poll_sec)
    if settings.telethon_ready:
        from .ingest_telethon import run_telethon

        _tasks.append(asyncio.create_task(run_telethon(broadcaster, geo)))
    else:
        log.warning("Telethon вимкнено (немає ключів) — працює лише bridge. HUMAN ACTION: ключі my.telegram.org")
    yield
    for t in _tasks:
        t.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await t


app = FastAPI(title="Air Target Radar", version="1.0", lifespan=_lifespan)


@app.get("/api/state")
async def api_state():
    return JSONResponse(broadcaster.snapshot())


@app.get("/api/stats")
async def api_stats(window: int = 3600):
    return JSONResponse(store.stats(window))


@app.get("/api/track/{obj_id}")
async def api_track(obj_id: str):
    return JSONResponse({"id": obj_id, "track": store.track(obj_id)})


@app.get("/api/health")
async def api_health():
    return {
        "status": "ok",
        "objects": broadcaster.object_count,
        "zones": len(broadcaster.zones),
        "clients": len(broadcaster.clients),
        "geo_names": len(geo.index),
        "telethon": settings.telethon_ready,
    }


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await broadcaster.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # ping/keepalive
    except WebSocketDisconnect:
        broadcaster.disconnect(websocket)
    except Exception:  # noqa: BLE001
        broadcaster.disconnect(websocket)


if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
