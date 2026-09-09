"""Движок предиктивних алертів: перетворює кореляцію «загроза→обʼєкт» на дію.

Правило: коли достатньо впевнений трек має у своєму коридорі критичний обʼєкт
із ETA нижче порога — піднімається алерт із рівнем терміновості. Це шар «і що з
того»: від споглядання даних до дій оператора.
"""

from __future__ import annotations

# Категорії обʼєктів, удар по яких має найвищі наслідки.
CRITICAL_CATS = {
    "power_plant",
    "substation",
    "dam",
    "hospital",
    "water",
    "oil_gas",
    "government",
    "data_center",
}


def severity(eta_min: float, category: str) -> str:
    crit = category in CRITICAL_CATS
    if eta_min <= 10 and crit:
        return "critical"
    if eta_min <= 20 and crit:
        return "high"
    if eta_min <= 15:
        return "high"
    return "medium"


def evaluate(
    tracks: dict,
    threatened: dict[str, list[dict]],
    min_conf: float = 0.55,
    max_eta: float = 30.0,
) -> list[dict]:
    """Список актуальних алертів, відсортований за терміновістю та ETA."""
    order = {"critical": 0, "high": 1, "medium": 2}
    out: list[dict] = []
    for tid, hits in threatened.items():
        t = tracks.get(tid)
        if not t or not hits:
            continue
        conf = min(0.99, t.confidence + (0.08 if getattr(t, "in_zone", False) else 0.0))
        if conf < min_conf:
            continue
        # найпріоритетніший обʼєкт: критичні категорії раніше, потім за ETA
        best = min(
            hits,
            key=lambda h: (0 if h["category"] in CRITICAL_CATS else 1, h["eta_min"]),
        )
        if best["eta_min"] > max_eta:
            continue
        sev = severity(best["eta_min"], best["category"])
        out.append(
            {
                "id": f"{tid}:{best['name']}",
                "track_id": tid,
                "label": t.to_dict()["label"],
                "asset": best["name"],
                "asset_category": best.get("category_label", best["category"]),
                "eta_min": best["eta_min"],
                "severity": sev,
                "confidence": round(conf, 2),
                "in_zone": bool(getattr(t, "in_zone", False)),
                "lat": best["lat"],
                "lon": best["lon"],
                "reason": f"{t.to_dict()['label']} у коридорі на «{best['name']}», ETA ~{round(best['eta_min'])} хв",
            }
        )
    out.sort(key=lambda a: (order.get(a["severity"], 3), a["eta_min"]))
    return out
