"""Тести планарної геометрії та крос-перевірки треків із зонами тривог."""

from backend.geometry import point_in_ring, zone_containing

# Квадрат ~1°×1° навколо (49..50, 30..31), точки [lat, lon].
SQUARE = [[49.0, 30.0], [49.0, 31.0], [50.0, 31.0], [50.0, 30.0]]
ZONES = [{"region": "Тестовобласть", "polygons": [SQUARE]}]


def test_point_inside():
    assert point_in_ring(49.5, 30.5, SQUARE) is True


def test_point_outside():
    assert point_in_ring(48.0, 30.5, SQUARE) is False
    assert point_in_ring(49.5, 32.0, SQUARE) is False


def test_zone_containing():
    assert zone_containing(49.5, 30.5, ZONES) == "Тестовобласть"
    assert zone_containing(45.0, 20.0, ZONES) is None


def test_degenerate_ring():
    assert point_in_ring(0, 0, [[1, 1], [2, 2]]) is False
