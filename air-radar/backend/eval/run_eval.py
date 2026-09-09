"""Раннер оцінки екстрактора: рахує метрики розбору по золотому набору.

Запуск як звіт:   python -m backend.eval.run_eval
Використання в тестах: from .run_eval import evaluate; assert evaluate()['type_acc'] >= ...
"""

from __future__ import annotations

from ..extractor import detect_type, extract
from ..geocode import GeoDB
from ..pipeline import build_from_message
from .cases import CASES


def evaluate(geo: GeoDB | None = None, verbose: bool = False) -> dict:
    geo = geo or GeoDB().load()
    n = len(CASES)
    type_ok = 0
    object_ok = 0
    dest_total = 0
    dest_ok = 0
    fails: list[str] = []

    for exp_type, text, exp_object, dest_sub in CASES:
        got_type, _ = detect_type(text)
        ex = extract(text, geo)
        obj = build_from_message(text, geo)
        got_object = obj is not None

        if got_type == exp_type:
            type_ok += 1
        elif verbose:
            fails.append(f"TYPE  очік={exp_type:9} got={got_type:9} | {text}")

        if got_object == exp_object:
            object_ok += 1
        elif verbose:
            fails.append(f"OBJ   очік={exp_object!s:5} got={got_object!s:5} | {text}")

        if dest_sub is not None:
            dest_total += 1
            if ex.destination and dest_sub.lower() in ex.destination.lower():
                dest_ok += 1
            elif verbose:
                fails.append(f"DEST  очік~{dest_sub:8} got={ex.destination} | {text}")

    metrics = {
        "cases": n,
        "type_acc": round(type_ok / n, 3),
        "object_acc": round(object_ok / n, 3),
        "dest_recall": round(dest_ok / dest_total, 3) if dest_total else 1.0,
        "fails": fails,
    }
    return metrics


def main() -> int:
    m = evaluate(verbose=True)
    print(f"Кейсів: {m['cases']}")
    print(f"Точність типу:     {m['type_acc']:.1%}")
    print(f"Точність обʼєкта:   {m['object_acc']:.1%}")
    print(f"Повнота призначення:{m['dest_recall']:.1%}")
    if m["fails"]:
        print("\nПровали:")
        for f in m["fails"]:
            print("  ", f)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
