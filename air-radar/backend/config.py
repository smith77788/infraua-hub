"""Конфігурація сервісу з .env (без обовʼязкової залежності python-dotenv)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _load_dotenv() -> None:
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip())


_load_dotenv()


def _split(v: str) -> list[str]:
    return [x.strip().lstrip("@") for x in v.split(",") if x.strip()]


@dataclass
class Settings:
    host: str = os.environ.get("HOST", "0.0.0.0")
    port: int = int(os.environ.get("PORT", "8000"))
    tg_api_id: int = int(os.environ.get("TG_API_ID", "0") or "0")
    tg_api_hash: str = os.environ.get("TG_API_HASH", "")
    tg_session: str = os.environ.get("TG_SESSION", "air_radar")
    tg_channels: list[str] = field(
        default_factory=lambda: _split(
            os.environ.get("TG_CHANNELS", "war_monitor,napramok,monitor_war")
        )
    )
    enable_bridge: bool = os.environ.get("ENABLE_BRIDGE", "1") not in ("0", "false", "")
    bridge_poll_sec: int = int(os.environ.get("BRIDGE_POLL_SECONDS", "20"))

    @property
    def telethon_ready(self) -> bool:
        return bool(self.tg_api_id and self.tg_api_hash)


settings = Settings()
