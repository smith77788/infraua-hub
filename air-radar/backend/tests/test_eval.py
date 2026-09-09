"""Eval як gate якості: не даємо розбору повідомлень деградувати нижче порогів."""

from backend.eval.run_eval import evaluate


def test_extractor_quality_thresholds():
    m = evaluate()
    assert m["type_acc"] >= 0.95, m
    assert m["object_acc"] >= 0.9, m
    assert m["dest_recall"] >= 0.9, m
