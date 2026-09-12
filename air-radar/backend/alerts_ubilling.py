"""Друге НЕЗАЛЕЖНЕ джерело стану тривог — і розбіжність як окремий сигнал.

Навіщо друге джерело. Досі вся картина тривог приходила з одного місця
(detoyshahed). Коли джерело одне, «підтвердження» неможливе за побудовою:
немає з чим звіряти. Тут додається незалежний канал — ubilling.net.ua
(перевірено запитом 12.09.2026: keyless, JSON, поле `cachedat` свіже,
17 областей у тривозі, ключі виду «Чернігівська область», «м. Київ»).

Два джерела дивляться на РІЗНИЙ рівень адміністративного поділу: detoyshahed
віддає переважно райони (заміряно: 57 районів, 6 громад, 4 області), ubilling —
області. Тому звіряємо не полігони з полігонами, а те, що з них випливає для
конкретної цілі: «трек стоїть в активній зоні за джерелом A» проти «область
цього треку в тривозі за джерелом B».

Розбіжність тут — НЕ шум і не помилка, яку треба сховати. Це самостійна
інформація: або одне джерело запізнюється, або цілі вже немає, або тривога
охоплює більше, ніж бачить монітор. Тому розбіжність доходить до інтерфейсу
нарівні зі збігом, а не мовчки усереднюється.
"""

from __future__ import annotations

import asyncio

import aiohttp

UBILLING_URL = "https://ubilling.net.ua/aerialalerts/"

# Стан звірки двох джерел для конкретного треку.
AGREEMENT_LABEL = {
    "both": "◎◎ підтверджено двома джерелами",
    "zone_only": "◎ лише зона монітора",
    "oblast_only": "◎ лише обласна тривога",
    "neither": "тривоги немає в жодного джерела",
    "unknown": "звірка недоступна",
}


def parse_states(payload: dict | None) -> dict[str, bool]:
    """Відповідь ubilling → {канонічна область: чи тривога зараз}."""
    from .regions import canon_oblast

    if not payload or not isinstance(payload.get("states"), dict):
        return {}
    out: dict[str, bool] = {}
    for raw, st in payload["states"].items():
        name = canon_oblast(raw)
        if not name or not isinstance(st, dict):
            continue
        out[name] = bool(st.get("alertnow"))
    return out


def agreement(in_zone: bool, oblast_alert: bool | None) -> str:
    """Звірка двох незалежних джерел для одного треку."""
    if oblast_alert is None:
        return "unknown"
    if in_zone and oblast_alert:
        return "both"
    if in_zone:
        return "zone_only"
    if oblast_alert:
        return "oblast_only"
    return "neither"


def confidence_delta(state: str) -> float:
    """Внесок звірки у впевненість.

    Підтвердження двома незалежними джерелами важить більше за одне, але не
    перетворює оцінку на визначеність. Розбіжність нічого не додає — і нічого
    не віднімає: вона означає невизначеність, а не спростування.
    """
    return {"both": 0.10, "zone_only": 0.04, "oblast_only": 0.04}.get(state, 0.0)


async def fetch_states(session: aiohttp.ClientSession) -> dict[str, bool]:
    try:
        async with session.get(
            UBILLING_URL, timeout=aiohttp.ClientTimeout(total=15)
        ) as r:
            if r.status != 200:
                return {}
            return parse_states(await r.json(content_type=None))
    except Exception:  # noqa: BLE001
        return {}


async def run_oblast_alerts(broadcaster, poll_sec: int = 45) -> None:
    """Фоновий цикл: тримає в броадкастері стан тривог за незалежним джерелом."""
    async with aiohttp.ClientSession(headers={"User-Agent": "air-radar/1.0"}) as session:
        while True:
            states = await fetch_states(session)
            if states:
                await broadcaster.set_oblast_alerts(states)
            await asyncio.sleep(poll_sec)
