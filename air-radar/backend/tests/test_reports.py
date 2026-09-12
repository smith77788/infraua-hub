"""Доповідь: короткі звʼязки — маршрут, далекі — різні цілі."""

from backend.reports import ReportPoint, chains_of_report, segment

# Реальні координати з видачі джерела (12.09.2026).
RIVNE = ReportPoint("Рівне", 50.619, 26.251, display_name="Рівне, Рівненська область")
HOSHCHA = ReportPoint("Гоща", 50.60, 26.66)
BERDYCHIV = ReportPoint("Бердичів", 49.90, 28.60)


def test_close_points_form_one_chain_with_course():
    chains = chains_of_report("r", [RIVNE, HOSHCHA])
    assert len(chains) == 1
    assert chains[0].route_label == "Рівне → Гоща"
    assert chains[0].heading is not None
    assert 60 < chains[0].heading < 120  # на схід


def test_distant_points_are_separate_targets_not_a_route():
    """Гіпотеза «перелік = маршрут» спростована даними: розрив ріже ланцюг."""
    chains = chains_of_report("r", [RIVNE, HOSHCHA, BERDYCHIV])
    assert len(chains) == 2
    assert [p.name for p in chains[1].points] == ["Бердичів"]
    assert chains[1].heading is None  # курсу з однієї точки не буває
    assert chains[1].siblings == 1  # але контекст хвилі зберігся


def test_head_is_last_mentioned_point():
    chains = chains_of_report("r", [RIVNE, HOSHCHA])
    assert chains[0].head.name == "Гоща"


def test_stable_id_survives_repeated_polling():
    a = chains_of_report("rep-1", [RIVNE, HOSHCHA])[0].stable_id(0)
    b = chains_of_report("rep-1", [RIVNE, HOSHCHA])[0].stable_id(0)
    assert a == b


def test_single_point_keeps_incident_id():
    p = ReportPoint("Ніжин", 51.05, 31.88, incident_id="inc-42")
    assert chains_of_report("rep", [p])[0].stable_id(0) == "inc-42"


def test_segment_handles_empty():
    assert segment([]) == []
