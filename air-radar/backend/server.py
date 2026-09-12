"""FastAPI-сервер тактичного радара: WebSocket-стрім, REST API та статика COP.

Життєвий цикл піднімає джерела даних (bridge + опційно Telethon) і фонове
прибирання прострочених обʼєктів.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time

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
        from .alerts_ubilling import run_oblast_alerts
        from .bridge_detoyshahed import run_bridge

        _tasks.append(
            asyncio.create_task(run_bridge(broadcaster, None, settings.bridge_poll_sec))
        )
        # Друге НЕЗАЛЕЖНЕ джерело тривог — щоб «підтвердження» мало з чим
        # звірятися. Окремий цикл: падіння одного джерела не тягне інше.
        _tasks.append(asyncio.create_task(run_oblast_alerts(broadcaster)))
        log.info("Bridge detoyshahed увімкнено (кожні %d c) + обласні тривоги", settings.bridge_poll_sec)
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


@app.get("/api/assets")
async def api_assets():
    from .broadcaster import ASSET_LIST

    return JSONResponse({"assets": ASSET_LIST})


@app.get("/api/threatened")
async def api_threatened():
    return JSONResponse({"threatened": broadcaster.threatened})


@app.get("/api/metrics")
async def api_metrics():
    from . import metrics

    return JSONResponse(metrics.compute(broadcaster))


@app.get("/api/alerts_feed")
async def api_alerts_feed():
    return JSONResponse({"alerts": broadcaster.alerts_feed})


@app.get("/api/history")
async def api_history(minutes: float = 60):
    return JSONResponse({"minutes": minutes, "paths": store.recent_paths(minutes)})


@app.get("/api/regions")
async def api_regions():
    """Обласний зріз обстановки: де саме зараз важко."""
    from . import rollup

    return JSONResponse(rollup.compute(broadcaster))


@app.get("/api/sources")
async def api_sources():
    """Реєстр джерел: хто говорить і чого це варте (походження в UI)."""
    from . import sources

    return JSONResponse(
        {
            "sources": sources.registry(),
            "oblast_alerts": broadcaster.oblast_alerts,
            "oblast_alerts_age_sec": (
                round(time.time() - broadcaster.oblast_alerts_ts)
                if broadcaster.oblast_alerts_ts
                else None
            ),
        }
    )


@app.get("/api/dossier/{track_id}")
async def api_dossier(track_id: str):
    """Досьє цілі: стан, походження, історія й що їй загрожує попереду."""
    t = broadcaster.tracks.tracks.get(track_id)
    if not t:
        return JSONResponse({"error": "не знайдено", "id": track_id}, status_code=404)
    d = t.to_dict()
    d["history"] = [{"lat": la, "lon": lo, "ts": ts} for la, lo, ts in t.history[-40:]]
    d["threatened"] = broadcaster.threatened.get(track_id, [])
    d["stored_track"] = store.track(track_id, limit=100)
    return JSONResponse(d)


@app.get("/api/sitrep")
async def api_sitrep():
    """Зведення обстановки одним обʼєктом — для експорту та передачі далі."""
    from . import metrics, rollup

    roll = rollup.compute(broadcaster)
    return JSONResponse(
        {
            "generated_at": time.time(),
            "summary": {
                "tracks": broadcaster.object_count,
                "zones": len(broadcaster.zones),
                "alerts": len(broadcaster.alerts_feed),
                "oblasts_with_alert": roll["oblasts_with_alert"],
            },
            "regions": roll["regions"],
            "alerts": broadcaster.alerts_feed,
            "tracks": [t.to_dict() for t in broadcaster.tracks.tracks.values()],
            "metrics": metrics.compute(broadcaster),
        }
    )


@app.get("/api/health")
async def api_health():
    return {
        "status": "ok",
        "objects": broadcaster.object_count,
        "zones": len(broadcaster.zones),
        "clients": len(broadcaster.clients),
        "geo_names": len(geo.index),
        "telethon": settings.telethon_ready,
        "oblast_alert_source": bool(broadcaster.oblast_alerts),
        "oblasts_with_alert": sum(1 for v in broadcaster.oblast_alerts.values() if v),
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
