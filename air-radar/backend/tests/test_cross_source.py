"""Звірка двох незалежних джерел тривог і обласний зріз."""

from backend.alerts_ubilling import agreement, confidence_delta, parse_states
from backend.regions import canon_oblast, nearest_oblast, oblast_of_display


def test_parse_states_canonicalises_regions():
    st = parse_states(
        {"states": {"Чернігівська область": {"alertnow": True},
                    "м. Київ": {"alertnow": False},
                    "Невідомий край": {"alertnow": True}}}
    )
    assert st["Чернігівська область"] is True
    assert st["м. Київ"] is False
    assert "Невідомий край" not in st


def test_two_sources_agreeing_outweighs_one():
    assert confidence_delta(agreement(True, True)) > confidence_delta(agreement(True, False))


def test_disagreement_neither_confirms_nor_refutes():
    assert confidence_delta(agreement(True, False)) > 0  # одне джерело все ж каже «так»
    assert confidence_delta(agreement(False, False)) == 0.0


def test_missing_second_source_is_marked_unknown_not_assumed_false():
    assert agreement(False, None) == "unknown"
    assert confidence_delta("unknown") == 0.0


def test_oblast_from_admin_chain_and_from_coordinates():
    assert oblast_of_display("Богодухів, Богодухівський район, Харківська область") == "Харківська область"
    assert oblast_of_display("") is None
    assert nearest_oblast(49.99, 36.23) == "Харківська область"


def test_oblast_adjective_forms():
    assert canon_oblast("Сумщина") == "Сумська область"
    assert canon_oblast("казна-що") is None
