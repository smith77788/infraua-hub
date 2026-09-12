"""Довіра до джерела: надійність і НЕЗАЛЕЖНІСТЬ підтверджень."""

from backend import sources


def test_official_channel_outranks_monitor():
    assert sources.base_confidence("kpszsu") > sources.base_confidence("radar_top_ua")
    assert sources.profile("kpszsu").tier == "official"


def test_unknown_channel_is_conservative():
    p = sources.profile("канал_якого_немає")
    assert p.reliability == "F"
    assert p.base_confidence <= 0.6
    assert p.tier == "unknown"


def test_same_operator_is_not_independent_confirmation():
    """Два канали одного власника — одне спостереження, а не два підтвердження."""
    assert sources.operator_of("chyste_nebo") == sources.operator_of("chyste_nebochernigv")
    assert sources.corroboration_bonus(["chyste_nebo", "chyste_nebochernigv"]) == 0.0


def test_independent_operators_add_confidence_with_ceiling():
    one = sources.corroboration_bonus(["kpszsu"])
    two = sources.corroboration_bonus(["kpszsu", "radar_top_ua"])
    many = sources.corroboration_bonus(
        ["kpszsu", "radar_top_ua", "eradarrua", "kudy_letyt", "chyste_nebo"]
    )
    assert one == 0.0
    assert two > one
    assert many <= 0.18  # стеля: корроборація не перетворює оцінку на факт


def test_channel_normalisation():
    assert sources.profile("@KpSzSu").tier == "official"
