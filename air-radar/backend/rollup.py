"""Обласний зріз обстановки: від переліку точок до відповіді «де важко зараз».

Карта з двома сотнями позначок показує все й не показує нічого: щоб зрозуміти,
де саме важко, оператор має сам звести точки в голові. Цей модуль зводить їх
за областями — одиницею, в якій в Україні й ухвалюють рішення про тривогу.

Область береться з адміністративного ланцюга джерела (спостережене) або, якщо
його немає, з найближчого обласного центру (виведене). Різниця не ховається:
`observed_share` показує, яка частка привʼязок у зведенні — спостережена.

Тиск (`pressure`) — навмисно проста зважена сума свіжих цілей, а не
ймовірність: свіжий трек важить повну одиницю, згасаючий — менше. Це оцінка
навантаження, і вона так і підписана.
"""

from __future__ import annotations

from .alerts_ubilling import AGREEMENT_LABEL, agreement

FRESH_SEC = 300
AGING_SEC = 900


def _weight(age_sec: float) -> float:
    if age_sec < FRESH_SEC:
        return 1.0
    if age_sec < AGING_SEC:
        return 0.6
    return 0.25


def compute(broadcaster) -> dict:
    """Зведення обстановки за областями, відсортоване за тиском."""
    import time

    now = time.time()
    zones_by_oblast: dict[str, bool] = {}
    for t in broadcaster.tracks.tracks.values():
        if t.oblast and t.in_zone:
            zones_by_oblast[t.oblast] = True

    rows: dict[str, dict] = {}
    for t in broadcaster.tracks.tracks.values():
        if not t.oblast:
            continue
        r = rows.setdefault(
            t.oblast,
            {
                "oblast": t.oblast,
                "tracks": 0,
                "fresh": 0,
                "pressure": 0.0,
                "observed": 0,
                "by_type": {},
                "moving": 0,
                "max_confidence": 0.0,
                "min_eta_min": None,
                "threatened_assets": set(),
            },
        )
        age = max(0.0, now - t.last_obs_ts)
        r["tracks"] += 1
        r["pressure"] += _weight(age) * max(1, t.count)
        if age < FRESH_SEC:
            r["fresh"] += 1
        if t.oblast_basis == "observed":
            r["observed"] += 1
        if t.heading is not None:
            r["moving"] += 1
        r["by_type"][t.type] = r["by_type"].get(t.type, 0) + 1
        r["max_confidence"] = max(r["max_confidence"], t.confidence)
        for h in broadcaster.threatened.get(t.id, []):
            r["threatened_assets"].add(h["name"])
            eta = h["eta_min"]
            if r["min_eta_min"] is None or eta < r["min_eta_min"]:
                r["min_eta_min"] = eta

    # Області, де тривога є, але цілей у видачі немає, теж мають бути видимі.
    for oblast, on in (broadcaster.oblast_alerts or {}).items():
        if on and oblast not in rows:
            rows[oblast] = {
                "oblast": oblast,
                "tracks": 0,
                "fresh": 0,
                "pressure": 0.0,
                "observed": 0,
                "by_type": {},
                "moving": 0,
                "max_confidence": 0.0,
                "min_eta_min": None,
                "threatened_assets": set(),
            }

    out = []
    for r in rows.values():
        oblast_alert = (broadcaster.oblast_alerts or {}).get(r["oblast"])
        state = agreement(zones_by_oblast.get(r["oblast"], False), oblast_alert)
        out.append(
            {
                **r,
                "pressure": round(r["pressure"], 2),
                "max_confidence": round(r["max_confidence"], 2),
                "min_eta_min": round(r["min_eta_min"], 1) if r["min_eta_min"] is not None else None,
                "threatened_assets": sorted(r["threatened_assets"]),
                "observed_share": round(r["observed"] / r["tracks"], 2) if r["tracks"] else None,
                "oblast_alert": oblast_alert,
                "zone_alert": zones_by_oblast.get(r["oblast"], False),
                "agreement": state,
                "agreement_label": AGREEMENT_LABEL[state],
            }
        )
    out.sort(key=lambda x: (-x["pressure"], -x["tracks"], x["oblast"]))
    return {
        "ts": now,
        "regions": out,
        "oblasts_with_alert": sum(1 for v in (broadcaster.oblast_alerts or {}).values() if v),
        "oblasts_known": len(broadcaster.oblast_alerts or {}),
    }
