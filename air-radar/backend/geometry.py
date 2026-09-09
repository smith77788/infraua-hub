"""Проста планарна геометрія для крос-перевірки треків із зонами тривог.

На масштабі області похибка планарного ray-casting незначна, зовнішніх
залежностей не потрібно.
"""

from __future__ import annotations


def point_in_ring(lat: float, lon: float, ring: list) -> bool:
    """Ray casting. ring — список точок [lat, lon]."""
    n = len(ring)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        yi, xi = ring[i][0], ring[i][1]
        yj, xj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def zone_containing(lat: float, lon: float, zones: list[dict]) -> str | None:
    """Назва першої зони тривоги, що містить точку, або None."""
    for z in zones:
        for ring in z.get("polygons", []):
            if point_in_ring(lat, lon, ring):
                return z.get("region")
    return None
