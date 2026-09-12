"""Структуровані тактичні обʼєкти та метадані типів цілей."""

from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict

# Метадані типів цілей: підпис, колір (COP-палітра) та типова швидкість (км/год).
TYPE_META: dict[str, dict] = {
    "ballistic": {"label": "Балістика", "color": "#ff1a1a", "speed_kmh": 3000},
    "cruise": {"label": "Крилата ракета", "color": "#ff4d4d", "speed_kmh": 800},
    "missile": {"label": "Ракета", "color": "#ff4d4d", "speed_kmh": 900},
    "kab": {"label": "КАБ", "color": "#f5a623", "speed_kmh": 900},
    "shahed": {"label": "Shahed / БпЛА", "color": "#ff9900", "speed_kmh": 180},
    "recon": {"label": "Розвід. БпЛА", "color": "#c084fc", "speed_kmh": 150},
    "aircraft": {"label": "Авіація", "color": "#22d3ee", "speed_kmh": 800},
    "unknown": {"label": "Ціль", "color": "#94a3b8", "speed_kmh": 200},
}

DEFAULT_TTL_SEC = 30 * 60  # обʼєкт «живе» 30 хв від останнього оновлення


@dataclass
class TacticalObject:
    id: str
    type: str
    lat: float
    lon: float
    source: str
    raw: str = ""
    channel: str = ""
    heading: float | None = None
    origin: str | None = None
    destination: str | None = None
    waypoints: list[list[float]] = field(default_factory=list)
    confidence: float = 0.5
    count: int = 1
    ts: float = field(default_factory=time.time)
    ttl: int = DEFAULT_TTL_SEC
    # Адміністративна привʼязка. `oblast_basis` розрізняє спостережене
    # (джерело дало адміністративний ланцюг) і виведене (найближчий центр).
    oblast: str | None = None
    oblast_basis: str = "unknown"  # observed | inferred | unknown
    # Контекст доповіді: одне повідомлення OSINT може нести кілька цілей.
    report_id: str = ""
    report_siblings: int = 0
    route: str | None = None  # «Рівне → Гоща», коли доповідь дала ланцюг

    @property
    def label(self) -> str:
        return TYPE_META.get(self.type, TYPE_META["unknown"])["label"]

    @property
    def color(self) -> str:
        return TYPE_META.get(self.type, TYPE_META["unknown"])["color"]

    @property
    def speed_kmh(self) -> int:
        return TYPE_META.get(self.type, TYPE_META["unknown"])["speed_kmh"]

    @property
    def vector(self) -> list[list[float]] | None:
        """Лінія курсу [ [lat,lon], [lat,lon] ] для відображення на карті."""
        if len(self.waypoints) >= 2:
            return [self.waypoints[0], self.waypoints[-1]]
        return None

    def expired(self, now: float | None = None) -> bool:
        return (now or time.time()) - self.ts > self.ttl

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(
            label=self.label,
            color=self.color,
            speed_kmh=self.speed_kmh,
            vector=self.vector,
            expires=self.ts + self.ttl,
        )
        return d
