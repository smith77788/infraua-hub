"""Шар поради: від «що в небі» до «що це означає особисто для вас».

Три речі, яких радар досі не робив, хоч дані для них уже були.

1. ВЕРИФІКАЦІЯ (анти-фейк). Впевненість у вигляді «87%» нічого не каже про
   те, ЧОМУ так. Тут вона розкладається на рівень із назвою: скільки
   НЕЗАЛЕЖНИХ операторів підтвердили (не каналів — операторів, див.
   sources.py) і чи накриває точку офіційна тривога з двох джерел.
   Непідтверджене одиночне повідомлення так і називається непідтвердженим.

2. ЧИСТЕ НЕБО (розумний відбій). Офіційний відбій дають по області й із
   запасом. Тут рахується інше: чи є ЗАРАЗ активні цілі в радіусі навколо
   точки і коли востаннє там щось бачили.

   Межа чесності, яку не можна переступати: відсутність даних — це не
   доказ відсутності загрози. Наше «небо чисте» означає рівно «в цьому
   радіусі OSINT не показує активних цілей», і саме так воно й підписане.
   Радара ми не маємо; ми маємо покриття повідомленнями.

3. ВІКНА Й УЛАМКИ. Азимут загрози відносно сторони, куди виходять вікна, —
   це геометрія, яку користувач не має рахувати в голові під тривогу.
"""

from __future__ import annotations

import math

from .geocode import azimuth_deg, haversine_km

# ── 1. Верифікація ───────────────────────────────────────────────────────
VERIFICATION = {
    "corroborated": "підтверджено незалежними джерелами",
    "official": "офіційне джерело",
    "single": "одне джерело, без підтвердження",
    "unverified": "джерело поза реєстром, підтверджень немає",
}


def verify(track) -> dict:
    """Рівень верифікації треку з поясненням, чому саме такий."""
    from . import sources

    channels = getattr(track, "sources", set()) or set()
    operators = sources.independent_operators(channels)
    profiles = [sources.profile(c) for c in channels]
    official = any(p.tier == "official" for p in profiles)
    all_unknown = bool(profiles) and all(p.tier == "unknown" for p in profiles)
    zone = bool(getattr(track, "in_zone", False))
    oblast = getattr(track, "oblast_alert", None)

    reasons = []
    if official:
        level = "official"
        reasons.append("серед джерел є офіційний канал Повітряних Сил")
    elif len(operators) >= 2:
        level = "corroborated"
        reasons.append(f"підтверджено {len(operators)} незалежними операторами")
    elif all_unknown:
        level = "unverified"
        reasons.append("канал не в реєстрі джерел")
    else:
        level = "single"
        reasons.append("повідомив один оператор")
    if len(channels) > len(operators):
        reasons.append("частина каналів належить одному оператору — це не окремі підтвердження")
    if zone and oblast:
        reasons.append("точка в активній тривозі за двома незалежними джерелами")
    elif zone or oblast:
        reasons.append("тривогу підтверджує лише одне з двох джерел")
    return {
        "level": level,
        "label": VERIFICATION[level],
        "operators": sorted(operators),
        "operator_count": len(operators),
        "reasons": reasons,
    }


# ── 2. Чисте небо ────────────────────────────────────────────────────────
def sky_clear(tracks, lat: float, lon: float, radius_km: float = 150.0) -> dict:
    """Чи є активні цілі навколо точки і коли там востаннє щось бачили."""
    import time

    now = time.time()
    inside = []
    for t in tracks:
        d = haversine_km((lat, lon), (t.ex_lat, t.ex_lon))
        if d <= radius_km:
            inside.append((d, t))
    inside.sort(key=lambda x: x[0])
    last_seen = max((t.last_obs_ts for _, t in inside), default=None)
    nearest = inside[0] if inside else None
    return {
        "radius_km": radius_km,
        "clear": not inside,
        "targets": len(inside),
        "nearest_km": round(nearest[0], 1) if nearest else None,
        "nearest_label": nearest[1].to_dict()["label"] if nearest else None,
        "last_seen_sec": round(now - last_seen) if last_seen else None,
        "verdict": (
            f"У радіусі {round(radius_km)} км активних цілей немає"
            if not inside
            else f"У радіусі {round(radius_km)} км — {len(inside)}, найближча за {round(nearest[0])} км"
        ),
        # Межа, яку не можна прибирати з відповіді.
        "caveat": (
            "Це покриття OSINT-повідомленнями, а не радар. Відсутність цілей "
            "у видачі не є доказом відсутності загрози; офіційний відбій дають "
            "Повітряні Сили."
        ),
    }


# ── 3. Вікна й знос уламків ──────────────────────────────────────────────
SIDES = {
    "N": (0, "північ"), "NE": (45, "північний схід"), "E": (90, "схід"),
    "SE": (135, "південний схід"), "S": (180, "південь"), "SW": (225, "південний захід"),
    "W": (270, "захід"), "NW": (315, "північний захід"),
}


def angle_diff(a: float, b: float) -> float:
    """Найменший кут між двома азимутами, 0..180."""
    return abs((((a - b) + 180) % 360) - 180)


def window_exposure(threat_bearing: float, window_side: str, half_sector: float = 55.0) -> dict:
    """Чи йде загроза з боку, куди виходять вікна."""
    side = SIDES.get(window_side)
    if side is None:
        return {"known": False}
    diff = angle_diff(threat_bearing, side[0])
    exposed = diff <= half_sector
    return {
        "known": True,
        "side": window_side,
        "side_label": side[1],
        "bearing": round(threat_bearing),
        "angle_off": round(diff),
        "exposed": exposed,
        "advice": (
            f"Загроза з боку ваших вікон ({side[1]}) — відійдіть від них, "
            "дві стіни між вами і вікном"
            if exposed
            else f"Загроза не з боку ваших вікон (вони на {side[1]}, загроза за {round(diff)}° від них)"
        ),
    }


def debris_drift(wind_dir_deg: float, wind_speed_ms: float, fall_sec: float = 30.0) -> dict:
    """Груба оцінка зносу уламків вітром.

    Це ОЦІНКА, а не розрахунок падіння: висота підриву, маса й форма уламка
    невідомі. Береться приземний вітер (10 м) і умовний час падіння; напрямок
    зносу — куди вітер дме (метеорологічний напрямок показує, ЗВІДКИ він).
    Числу тут вірити не можна далі за порядок величини, і воно так підписане.
    """
    to_deg = (wind_dir_deg + 180) % 360
    drift_m = wind_speed_ms * fall_sec
    return {
        "drift_to_deg": round(to_deg),
        "drift_to_label": min(SIDES.values(), key=lambda s: angle_diff(s[0], to_deg))[1],
        "drift_m": round(drift_m),
        "basis": (
            f"приземний вітер {wind_speed_ms:.1f} м/с, умовний час падіння "
            f"{round(fall_sec)} с — оцінка порядку, не розрахунок траєкторії"
        ),
    }
