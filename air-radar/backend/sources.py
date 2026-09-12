"""Достовірність джерела: хто сказав і чи можна вважати це підтвердженням.

Проблема, яку це закриває. Досі всі канали важили однаково: повідомлення
офіційного каналу Повітряних Сил і повідомлення анонімного монітора давали
однакову впевненість 0.9. Гірше те, що корроборація рахувалася за НАЗВАМИ
каналів: два канали одного оператора («чисте небо» загальний і «чисте небо
Чернігів») зараховувалися як два незалежні підтвердження, хоча за ними стоїть
та сама людина і те саме первинне спостереження.

Рішення — профіль джерела з двома окремими властивостями:

1. `reliability` — код Адміралтейства (A..F), доменна шкала розвідки.
   Використовується як стеля базової впевненості.
2. `operator` — хто стоїть за каналом. Саме за операторами, а не за назвами
   каналів, рахується незалежність підтверджень.

Заземлення (правило 4 AGENTS.md — нічого не вигадувати):
- `kpszsu` — офіційний канал Повітряних Сил ЗСУ; це публічно відомий факт,
  тому єдиний канал із рівнем `official`.
- Решта каналів у реєстрі — ті, що реально зустрілися у видачі
  detoyshahed (перевірено запитом). Про їхніх власників нам нічого не
  відомо, тому оператором вважається сам канал, а рівень — `monitor`.
- Канал, якого немає в реєстрі, НЕ вважається надійним за замовчуванням:
  він отримує `unknown`/`F`. Це навмисно консервативно.
"""

from __future__ import annotations

from dataclasses import dataclass

# Код Адміралтейства → стеля базової впевненості спостереження.
# Це оцінка методу, а не ймовірність: числа свідомо грубі.
RELIABILITY_CONF = {
    "A": 0.95,  # офіційне джерело
    "B": 0.85,  # монітор із тривалою історією влучності
    "C": 0.75,  # звичайний OSINT-монітор
    "D": 0.65,
    "F": 0.55,  # надійність оцінити неможливо
}

TIER_LABEL = {
    "official": "офіційне джерело",
    "monitor": "OSINT-монітор",
    "aggregator": "агрегатор",
    "unknown": "невідоме джерело",
}


@dataclass(frozen=True)
class SourceProfile:
    channel: str
    operator: str  # основа незалежності підтверджень
    tier: str  # official | monitor | aggregator | unknown
    reliability: str  # код Адміралтейства A..F
    note: str

    @property
    def tier_label(self) -> str:
        return TIER_LABEL.get(self.tier, self.tier)

    @property
    def base_confidence(self) -> float:
        return RELIABILITY_CONF.get(self.reliability, 0.55)

    def to_dict(self) -> dict:
        return {
            "channel": self.channel,
            "operator": self.operator,
            "tier": self.tier,
            "tier_label": self.tier_label,
            "reliability": self.reliability,
            "base_confidence": self.base_confidence,
            "note": self.note,
        }


# Канали одного оператора не є незалежними підтвердженнями. Підстава тут —
# спільний префікс назви (спостережено у видачі джерела), тобто евристика,
# а не знання про власників. Свідомо консервативна: злиття в одного оператора
# ЗНИЖУЄ впевненість, тому помилка тут не завищує картину.
_OPERATOR_FAMILIES = ("chyste_nebo",)


def _family_operator(channel: str) -> str:
    """Оператор каналу: сімейство за спільним префіксом, інакше сам канал."""
    for fam in _OPERATOR_FAMILIES:
        if channel.startswith(fam):
            return fam
    return channel


def _monitor(channel: str, note: str = "Публічний OSINT-монітор повітряної обстановки") -> SourceProfile:
    return SourceProfile(channel, _family_operator(channel), "monitor", "C", note)


_REGISTRY: dict[str, SourceProfile] = {
    "kpszsu": SourceProfile(
        "kpszsu",
        "Повітряні Сили ЗСУ",
        "official",
        "A",
        "Офіційний канал Повітряних Сил ЗСУ",
    ),
    "detoyshahed": SourceProfile(
        "detoyshahed",
        "detoyshahed",
        "aggregator",
        "C",
        "Агрегатор публічних каналів — переносить чуже спостереження, не своє",
    ),
}
for _ch in (
    "ukrainealarmsignal",
    "radar_top_ua",
    "ukrainian_intelligence",
    "chyste_nebo",
    "chyste_nebochernigv",
    "kudy_letyt",
    "eradarrua",
    "kyiv airdefense",
):
    _REGISTRY[_ch] = _monitor(_ch)

def _norm(channel: str) -> str:
    return (channel or "").strip().lstrip("@").lower()


def profile(channel: str) -> SourceProfile:
    """Профіль каналу; для незнайомого — консервативний `unknown`/F."""
    key = _norm(channel)
    if key in _REGISTRY:
        return _REGISTRY[key]
    for fam in _OPERATOR_FAMILIES:
        if key.startswith(fam):
            return SourceProfile(key, fam, "monitor", "C", f"Канал сімейства «{fam}»")
    return SourceProfile(
        key or "unknown", key or "unknown", "unknown", "F", "Канал не в реєстрі джерел"
    )


def operator_of(channel: str) -> str:
    return profile(channel).operator


def base_confidence(channel: str) -> float:
    return profile(channel).base_confidence


def independent_operators(channels) -> set[str]:
    """Множина НЕЗАЛЕЖНИХ операторів за переліком каналів."""
    return {operator_of(c) for c in channels if c}


def corroboration_bonus(channels) -> float:
    """Надбавка за підтвердження незалежними операторами.

    За найслабшою ланкою логіки корроборації: додає лише другий і наступні
    НЕЗАЛЕЖНІ оператори. Повтори того самого оператора не додають нічого.
    """
    n = len(independent_operators(channels))
    if n <= 1:
        return 0.0
    return min(0.18, 0.09 * (n - 1))


def registry() -> list[dict]:
    """Реєстр відомих джерел — для показу походження в інтерфейсі."""
    return [p.to_dict() for p in _REGISTRY.values()]
